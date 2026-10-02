import { issueLink, revokeSignInCredentials } from "./link-issuance.mjs";
import { openRecoveryStore, recoveryOrigin, validateRecoveryStore, selectRecoveryAdmin,
  recoveryFailure, recoveryWaitRemaining, RECOVERY_BUSY_TIMEOUT_MS } from "./recovery-store.mjs";

export const RECOVERY_LIFETIME_MS = 15 * 60 * 1000;

export function recoverAdmin({ dataDir, origin, email }, now) {
  const instanceOrigin = recoveryOrigin(origin);
  const deadline = performance.now() + RECOVERY_BUSY_TIMEOUT_MS;
  const db = openRecoveryStore(dataDir, deadline);
  try {
    // Opening and acquiring the write lock share one contention budget.
    db.pragma(`busy_timeout = ${recoveryWaitRemaining(deadline)}`);
    return db.transaction(() => {
      validateRecoveryStore(db);
      const account = selectRecoveryAdmin(db, email);
      const at = now ?? Date.now();
      revokeSignInCredentials(account.id, db, at, { revokeTokens: true });
      const link = issueLink(account.id, "reset", db, at, RECOVERY_LIFETIME_MS);
      return { account, expiresAt: link.expiresAt,
        url: `${instanceOrigin}/accept#secret=${encodeURIComponent(link.secret)}` };
    }).immediate();
  } catch (error) { throw recoveryFailure(error); }
  finally { db.close(); }
}
