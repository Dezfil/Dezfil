import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { requirePasswordSignIn } from "./external-sign-in/refusal";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { linkByHash, revokeSessions, revokeTokens } from "@/lib/metadata/auth-credentials";
import { stopAccountAssistantWork } from "@/lib/assistant/retained-work";
import { issueSession, secretHash } from "./credentials";
import { maintainCredentials } from "./credential-maintenance";
import { AuthError, requireAuthenticationWanted } from "./errors";
import { hashPassword, validatePassword } from "./passwords";
import { securitySettings } from "./security-settings";

/**
 * Whoever redeems a link becomes the account, and an earlier holder keeps nothing
 * that could spend what the person adds afterwards: their sessions and tokens go
 * with the transaction, delegations die with their parents, and the account's
 * assistant work begun before this ends, running and parked.
 */
export async function redeemSignInLink(secret: string, password: string,
  db: Database = metadataDb(), now?: number, signal?: AbortSignal) {
  requirePasswordSignIn();
  maintainCredentials(db, now);
  const readLink = (at: number) => {
    const link = linkByHash(secretHash(secret), db);
    const account = link && getAccount(link.account_id, db);
    if (!link || !account || link.revoked_at !== null || link.consumed_at !== null ||
        link.expires_at <= at || account.status === "deactivated") {
      throw new AuthError("invalid_link", "This sign-in link is unavailable.", 401);
    }
    return link;
  };
  readLink(now ?? Date.now());
  const passwordHash = await hashPassword(password, { class: "protected", signal, minimum: securitySettings(db).passwordMin });
  const redeemed = await withStorageRecovery(() => db.transaction(() => {
    requireAuthenticationWanted(signal);
    const at = now ?? Date.now();
    const link = readLink(at);
    // A shortest password saved while the hash was computed decides, before the link is spent.
    validatePassword(password, securitySettings(db).passwordMin);
    db.prepare("UPDATE auth_links SET consumed_at = ? WHERE id = ?").run(at, link.id);
    revokeSessions(link.account_id, at, null, db);
    revokeTokens(link.account_id, at, db);
    db.prepare(`UPDATE accounts SET password_hash = ?, status = 'active',
      updated_at = ?, last_sign_in_at = ? WHERE id = ?`)
      .run(passwordHash, new Date(at).toISOString(), new Date(at).toISOString(), link.account_id);
    return { accountId: link.account_id, session: issueSession(getAccount(link.account_id, db)!, db, at) };
  }).immediate());
  // After the commit, so a turn the fresh session begins counts as newer. A parked
  // run then answers as one that credentials ended, not as a key change.
  stopAccountAssistantWork(redeemed.accountId, "credentials");
  return redeemed.session;
}
