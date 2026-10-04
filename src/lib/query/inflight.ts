import { registerQueryStore } from "./retained";
/**
 * In-flight artifact readers: every bounded evaluation and every direct
 * artifact read registers here, so retirement can wait for readers that
 * may have bound a replaced artifact's path before its swap committed.
 * Settling drains a snapshot — only work in flight at call time is waited
 * on; readers starting later already see the new registry state.
 */

const key = Symbol.for("dezfil.artifact-readers");
const host = globalThis as typeof globalThis & { [key]?: Set<Promise<unknown>> };
const inflight = host[key] ??= new Set<Promise<unknown>>();

export function trackInflight<T>(run: Promise<T>): Promise<T> {
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inflight.add(settled);
  void settled.then(() => inflight.delete(settled));
  return run;
}

export function inflightSettled(): Promise<void> {
  return Promise.all([...inflight]).then(() => undefined);
}

registerQueryStore({ drain: inflightSettled, busy: () => inflight.size > 0, clear: () => inflight.clear() });

export function readersForTests(): number { return inflight.size; }
