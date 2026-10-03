import { createHash, randomBytes, randomUUID } from "node:crypto";

export const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function secretHash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

export function newSecret(kind) {
  return `dz_${kind}_${randomBytes(32).toString("base64url")}`;
}

function requireTransaction(db) {
  if (!db.inTransaction) throw new Error("Link issuance requires a write transaction.");
}

/** The caller selects and authorizes the account in the same write transaction. */
export function revokeSignInCredentials(accountId, db, now, { revokeTokens = false } = {}) {
  requireTransaction(db);
  db.prepare("UPDATE accounts SET password_hash = NULL, updated_at = ? WHERE id = ?")
    .run(new Date(now).toISOString(), accountId);
  db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
    .run(now, accountId);
  if (revokeTokens) {
    db.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
      .run(now, accountId);
  }
}

export function issueLink(accountId, kind, db, now, lifetimeMs = LINK_LIFETIME_MS) {
  requireTransaction(db);
  const secret = newSecret("link");
  const expiresAt = now + lifetimeMs;
  db.prepare(`UPDATE auth_links SET revoked_at = ?
    WHERE account_id = ? AND revoked_at IS NULL AND consumed_at IS NULL`).run(now, accountId);
  db.prepare(`INSERT INTO auth_links
    (id, account_id, kind, secret_hash, created_at, expires_at, consumed_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`)
    .run(randomUUID(), accountId, kind, secretHash(secret), now, expiresAt);
  return { secret, expiresAt };
}
