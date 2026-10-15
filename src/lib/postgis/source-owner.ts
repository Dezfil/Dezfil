import { currentTrustedOperation, type TrustedOperation } from "@/lib/trusted-operation";
import { trustedEngineError } from "@/lib/trusted-connection";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";

export function assertPreviewActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EvaluationCancelled();
}

/** The source's own statement ceiling for previews and other interactive work. */
export const SOURCE_STATEMENT_MS = 30_000;

/** The statement ceiling a source attachment opened now carries, and whether
 * it is the operation's own remaining time. Accepted processing continues
 * after departure, so it takes all of its remaining time. Work that cancels on
 * departure keeps the 30 s ceiling at most: the native interrupt does not
 * reach a read blocked on the server, so only the ceiling ends that read
 * within the settlement allowance after the caller leaves. A preview keeps
 * its 30 s ceiling. */
export function sourceStatementCeiling(preview: boolean, operation?: TrustedOperation): { ms: number; ownDeadline: boolean } {
  if (preview || !operation) return { ms: SOURCE_STATEMENT_MS, ownDeadline: false };
  const remaining = Math.max(1, Math.ceil(operation.deadline - performance.now()));
  if (!operation.cancelsOnDeparture || remaining <= SOURCE_STATEMENT_MS) return { ms: remaining, ownDeadline: true };
  return { ms: SOURCE_STATEMENT_MS, ownDeadline: false };
}

/** Translate the source's statement ceiling before connection/filter wrappers
 * erase its cause. A ceiling that is the operation's remaining time answers
 * as that operation's own time limit, so processing answers
 * data_processing_timeout; the 30 s ceiling answers that the source query
 * took too long. Never return the engine message, which can contain secrets. */
export function sourceError(error: unknown, ownDeadline?: TrustedOperation): unknown {
  if (error instanceof ApiError || error instanceof EvaluationCancelled) return error;
  const message = error instanceof Error ? error.message : "";
  if (/(?:^|:\s*|\n\s*)ERROR:\s+canceling statement due to statement timeout\b/i.test(message)) {
    if (ownDeadline) return ownDeadline.refuseAtDeadline();
    return new ApiError("query_timeout", "The PostGIS source query took too long.", 408);
  }
  return error;
}

/** Each source attachment owns its native work through DETACH, and
 * interrupts stop before teardown so cleanup cannot interrupt itself. */
export class PgSourceOwner {
  private readonly operation = currentTrustedOperation();
  private stopInterrupting?: () => void;
  private ownDeadline = false;
  constructor(readonly signal?: AbortSignal, private readonly preview = false) {}

  /** The statement ceiling for the attachment this owner opens now. */
  attachmentCeiling(): number {
    const ceiling = sourceStatementCeiling(this.preview, this.operation);
    this.ownDeadline = ceiling.ownDeadline;
    return ceiling.ms;
  }

  /** The source error as this owner's answer, see sourceError. */
  classify(error: unknown): unknown {
    return sourceError(trustedEngineError(error), this.ownDeadline ? this.operation : undefined);
  }

  check(): void { this.operation?.assertCanCommit(); assertPreviewActive(this.signal); }

  async query<T>(work: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    this.check();
    let result: T;
    try { result = await work(); } catch (error) {
      this.check();
      const classified = this.classify(error);
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
