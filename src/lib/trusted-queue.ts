import { currentTrustedOperation } from "./trusted-operation";

/** A refused waiter can leave before its predecessor finishes. The queue tail
 * still follows that predecessor, so later work cannot bypass an active writer.
 * Once work starts, its actual completion owns cleanup and releases the turn. */
export function trustedQueueTurn<T>(previous: Promise<unknown>, work: () => Promise<T>) {
  const operation = currentTrustedOperation();
  let started = false;
  const abandoned = Promise.withResolvers<never>();
  const abort = () => { if (!started) abandoned.reject(operation!.signal.reason); };
  const start = () => { started = true; operation?.assertCanCommit(); return work(); };
  const running = previous.then(start, start);
  operation?.signal.addEventListener("abort", abort, { once: true });
  if (operation?.signal.aborted) abort();
  const result = Promise.race([running, abandoned.promise]).finally(() => operation?.signal.removeEventListener("abort", abort));
  return { running, result };
}
