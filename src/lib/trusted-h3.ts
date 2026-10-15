import { registerQueryStore } from "./query/retained";
import type { DuckDBInstance } from "@duckdb/node-api";
import { currentTrustedOperation, isTrustedOperationRefusal } from "./trusted-operation";
import { runTrustedConnection, trustedEngineError } from "./trusted-connection";
import { sharedTrustedWork } from "./trusted-shared";

const pending = new Set<Promise<void>>();
registerQueryStore({ drain: async () => { await Promise.allSettled([...pending]); }, busy: () => pending.size > 0, clear() {} });
const attempts = new WeakMap<DuckDBInstance, ReturnType<typeof sharedTrustedWork<boolean>>>();

/** One optional load/install attempt per instance. Independent callers keep
 * the shared loader alive; a resource refusal is retryable, not unavailable. */
export function loadTrustedH3(instance: DuckDBInstance): Promise<boolean> {
  let shared = attempts.get(instance);
  if (!shared) {
    shared = sharedTrustedWork({ kind: "interactive-read", name: "H3 preparation" }, async () => {
      const conn = await instance.connect().catch(error => { throw trustedEngineError(error); });
      return runTrustedConnection(conn, async guarded => {
        try {
          try { await guarded.run("LOAD h3"); }
          catch (error) {
            if (isTrustedOperationRefusal(error)) throw error;
            await guarded.run("INSTALL h3 FROM community");
            await guarded.run("LOAD h3");
          }
          return true;
        } catch (error) {
          if (isTrustedOperationRefusal(error)) throw error;
          return false;
        }
      }, currentTrustedOperation());
    });
    attempts.set(instance, shared);
    const attempt = shared;
    void shared.value.catch(() => { if (attempts.get(instance) === attempt) attempts.delete(instance); });
    const drained = shared.drained;
    pending.add(drained); void drained.then(() => pending.delete(drained));
  }
  return shared.join();
}
