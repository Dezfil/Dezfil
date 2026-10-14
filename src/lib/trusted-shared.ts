import { admitTrustedOperation, currentTrustedOperation, type TrustedOperationOptions } from "./trusted-operation";

/** A shared read has its own deadline and independent interests. Each caller
 * still waits within its own operation; a later caller cannot renew this one. */
export function sharedTrustedWork<T>(options: Pick<TrustedOperationOptions, "kind" | "name">, read: () => Promise<T>) {
  const parent = currentTrustedOperation();
  parent?.assertCanCommit();
  const operation = admitTrustedOperation({ ...options, shared: true, signal: parent?.signal,
    ...(parent ? { kind: parent.kind, budgetMs: parent.budgetMs, deadline: parent.deadline } : {}),
  });
  let complete = false;
  const value = operation.run(read);
  void value.then(() => { complete = true; }, () => { complete = true; });
  let first = true;
  return {
    value, drained: operation.drained,
    join(): Promise<T> {
      let leave: (() => void) | undefined;
      if (first) first = false;
      else if (!complete) leave = operation.join(currentTrustedOperation()?.signal);
      const signal = currentTrustedOperation()?.signal;
      let abort: (() => void) | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return Promise.race([value, stopped]).finally(() => {
        if (abort) signal?.removeEventListener("abort", abort);
        leave?.();
      });
    },
  };
}
