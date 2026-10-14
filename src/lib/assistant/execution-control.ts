import { retainAssistantCleanup } from "./retained-work";
import type { AccountScope } from "@/lib/auth/scope";
import { assistantRuns } from "./runs";

export interface ExecutionControl { signal: AbortSignal; depart(): void; detach(): void }
/** Each resolution gets a new execution stream. Observers never attach here. */
export function executionControl(scope: AccountScope, id: string, request: Request): ExecutionControl {
  // Abort forwarding can be weakly held by the Request. Keep its owner until
  // this execution detaches, then release it even if the control stays alive.
  let retainedRequest: Request | undefined = request;
  const requestSignal = request.signal;
  const signal = assistantRuns.signal(scope, id);
  const depart = () => { if (!assistantRuns.settleInactive(id)) assistantRuns.cancel(scope, id); };
  if (requestSignal.aborted) depart();
  else requestSignal.addEventListener("abort", depart, { once: true });
  const detach = retainAssistantCleanup(scope.accountId, () => {
    retainedRequest?.signal.removeEventListener("abort", depart);
    retainedRequest = undefined;
  });
  return { signal, depart, detach };
}
