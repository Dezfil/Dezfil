import type { DuckDBConnection } from "@duckdb/node-api";
import { currentTrustedOperation, isTrustedOperationRefusal, trustedMemoryRefusal, type TrustedOperation } from "./trusted-operation";

/** Translate at the native boundary, before a format-specific catch can
 * mistake resource exhaustion for an unreadable source. */
export function trustedEngineError(error: unknown, operation = currentTrustedOperation()): unknown {
  if (!operation || isTrustedOperationRefusal(error)) return error;
  if (error instanceof Error && /^out of memory error/i.test(error.message)) {
    return trustedMemoryRefusal(operation.name, /max_temp_directory_size|offload|temporary directory/i.test(error.message) ? "scratch" : "memory");
  }
  return error;
}

/** Keep native work owned until it settles. Interrupt never closes a handle
 * while its statement is running, and a late connection cannot start work. */
export async function runTrustedConnection<T>(conn: DuckDBConnection, work: (conn: DuckDBConnection) => Promise<T>, operation?: TrustedOperation): Promise<T> {
  const stop = operation?.onStop(() => conn.interrupt());
  const guarded = operation ? new Proxy(conn, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!/^(run|stream|prepare)/.test(String(key))) return value.bind(target);
      return async (...args: unknown[]) => {
        operation.assertCanCommit();
        try {
          const answer = await value.apply(target, args);
          try { operation.assertCanCommit(); }
          catch (error) { if (key === "prepare") answer.destroySync(); throw error; }
          return answer;
        }
        catch (error) { const mapped = trustedEngineError(error, operation); if (isTrustedOperationRefusal(mapped)) operation.refuse(mapped); operation.assertCanCommit(); throw mapped; }
      };
    },
  }) : conn;
  try { operation?.assertCanCommit(); return await work(guarded); }
  // Domain errors may still need the owning caller's format-specific translation.
  catch (error) { const mapped = trustedEngineError(error, operation); if (operation && mapped !== error) operation.refuse(mapped); operation?.assertCanCommit(); throw mapped; }
  finally { stop?.(); conn.disconnectSync(); }
}
