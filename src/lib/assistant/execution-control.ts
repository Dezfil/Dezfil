import { assistantRuns } from "./runs";

export interface ExecutionControl { signal: AbortSignal; depart(): void; detach(): void }
/** Each resolution gets a new execution stream. Observers never attach here. */
export function executionControl(id: string, requestSignal: AbortSignal): ExecutionControl {
  const signal = assistantRuns.signal(id);
  const depart = () => assistantRuns.cancel(id);
  if (requestSignal.aborted) depart();
  else requestSignal.addEventListener("abort", depart, { once: true });
  return { signal, depart, detach() { requestSignal.removeEventListener("abort", depart); } };
}
