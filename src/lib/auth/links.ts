import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { linkByHash, revokeSessions } from "@/lib/metadata/auth-credentials";
import { issueSession, secretHash } from "./credentials";
import { maintainCredentials } from "./credential-maintenance";
import { AuthError, requireAuthenticationWanted } from "./errors";
import { hashPassword } from "./passwords";
import { securitySettings } from "./security-settings";

export async function redeemSignInLink(secret: string, password: string,
  db: Database = metadataDb(), now?: number, signal?: AbortSignal) {
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
  return db.transaction(() => {
    requireAuthenticationWanted(signal);
    const at = now ?? Date.now();
    const link = readLink(at);
    db.prepare("UPDATE auth_links SET consumed_at = ? WHERE id = ?").run(at, link.id);
    revokeSessions(link.account_id, at, null, db);
    db.prepare(`UPDATE accounts SET password_hash = ?, status = 'active',
      updated_at = ?, last_sign_in_at = ? WHERE id = ?`)
      .run(passwordHash, new Date(at).toISOString(), new Date(at).toISOString(), link.account_id);
    return issueSession(getAccount(link.account_id, db)!, db, at);
  }).immediate();
}
