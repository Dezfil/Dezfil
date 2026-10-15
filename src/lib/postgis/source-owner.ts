import { currentTrustedOperation } from "@/lib/trusted-operation";
import { trustedEngineError } from "@/lib/trusted-connection";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";

export function assertPreviewActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EvaluationCancelled();
}

/** Translate the source's statement ceiling before connection/filter wrappers
 * erase its cause. Never return the engine message, which can contain secrets. */
export function previewSourceError(error: unknown): unknown {
  if (error instanceof ApiError || error instanceof EvaluationCancelled) return error;
  const message = error instanceof Error ? error.message : "";
  if (/(?:^|:\s*|\n\s*)ERROR:\s+canceling statement due to statement timeout\b/i.test(message)) {
    return new ApiError("query_timeout", "The PostGIS source query took too long.", 408);
  }
  return error;
}

/** Each source attachment owns its native work through DETACH, and
 * interrupts stop before teardown so cleanup cannot interrupt itself. */
export class PgSourceOwner {
  private readonly operation = currentTrustedOperation();
  private stopInterrupting?: () => void;
  constructor(readonly signal?: AbortSignal) {}

  check(): void { this.operation?.assertCanCommit(); assertPreviewActive(this.signal); }

  async query<T>(work: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    this.check();
    let result: T;
    try { result = await work(); } catch (error) {
      this.check();
      const classified = previewSourceError(trustedEngineError(error));
      this.operation?.refuseIfFinal(classified);
      throw classified;
    }
    try { this.check(); } catch (error) { discard?.(result); throw error; }
    return result;
  }

  bind(conn: DuckDBConnection): DuckDBConnection {
    this.check();
    let repeater: ReturnType<typeof setInterval> | undefined;
    const interrupt = () => {
      conn.interrupt();
      repeater ??= setInterval(() => conn.interrupt(), 100);
    };
    this.signal?.addEventListener("abort", interrupt, { once: true });
    this.stopInterrupting = () => {
      this.signal?.removeEventListener("abort", interrupt);
      if (repeater) clearInterval(repeater);
    };
    // Own preparation, stream acquisition and every asynchronous chunk read. Bind other
    // methods to the native object so its internal receiver stays intact.
    return new Proxy(conn, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key === "prepare") {
          return (...args: Parameters<DuckDBConnection["prepare"]>) => this.query(
            () => target.prepare(...args), prepared => prepared.destroySync());
        }
        if (key === "stream") {
          return async (...args: Parameters<DuckDBConnection["stream"]>) => {
            const result = await this.query(() => target.stream(...args));
            return new Proxy(result, {
              get: (stream, member) => {
                const method = Reflect.get(stream, member);
                if (member === "fetchChunk") return () => this.query(() => stream.fetchChunk());
                return typeof method === "function" ? method.bind(stream) : method;
              },
            });
          };
        }
        if (key === "run" || key === "runAndReadAll") {
          return (...args: unknown[]) => this.query(async () => Reflect.apply(value, target, args));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  drainComplete(): void { this.stopInterrupting?.(); }
}
