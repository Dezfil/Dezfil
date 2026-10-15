import { admitTrustedOperation, currentTrustedOperation, type TrustedOperation, type TrustedOperationOptions } from "./trusted-operation";

/** Mutation callers receive a refusal after owned cleanup, so a retry sees
 * released locks and no abandoned artifacts. The settlement allowance still
 * bounds that wait; an overdue native owner is reported separately. */
export function withTrustedMutation<T>(options: TrustedOperationOptions, work: (operation: TrustedOperation) => Promise<T>): Promise<T> {
  const inherited = currentTrustedOperation();
  if (inherited) return inherited.within(work);
  const operation = admitTrustedOperation(options);
  return operation.run(work).catch(async error => {
    try { await operation.settled; }
    catch (settlementError) { console.warn("Trusted operation cleanup failed", settlementError); }
    throw error;
  });
}
