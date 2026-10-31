import type { Database } from "better-sqlite3";

export const CREDENTIAL_PAGE_SIZE = 500;
export const EXPIRED_CREDENTIAL_MARGIN_MS = 86_400_000;
export const REVOKED_TOKEN_RETENTION_MS = 30 * EXPIRED_CREDENTIAL_MARGIN_MS;
export const credentialKinds = ["sessions", "links", "tokens", "ticket_ids"] as const;
export type CredentialKind = typeof credentialKinds[number];

/** Page every row, including live rows: a deletion limit is not a scan bound. */
export function credentialPage(db: Database, kind: CredentialKind, after: string | undefined): string[] {
  const query = after === undefined
    ? `SELECT id FROM auth_${kind} ORDER BY id LIMIT ?`
    : `SELECT id FROM auth_${kind} WHERE id > ? ORDER BY id LIMIT ?`;
  const rows = db.prepare(query).all(...(after === undefined ? [] : [after]), CREDENTIAL_PAGE_SIZE) as { id: string }[];
  return rows.map(row => row.id);
}

/** Recheck the stored expiry/revocation while holding the write lock. A page
 * selected before another connection renews a session is not deletion authority. */
export function removeExpiredCredentials(db: Database, kind: CredentialKind, ids: string[], now: number): number {
  if (ids.length > CREDENTIAL_PAGE_SIZE) throw new Error("Credential maintenance page exceeds its bound.");
  return db.transaction(() => {
    const predicate = kind === "tokens" ? "revoked_at IS NOT NULL AND revoked_at <= ?" : "expires_at <= ?";
    const cutoff = now - (kind === "ticket_ids" ? 0 : kind === "tokens" ? REVOKED_TOKEN_RETENTION_MS : EXPIRED_CREDENTIAL_MARGIN_MS);
    const remove = db.prepare(`DELETE FROM auth_${kind} WHERE id = ? AND ${predicate}`);
    let removed = 0;
    for (const id of ids) removed += remove.run(id, cutoff).changes;
    return removed;
  }).immediate();
}
