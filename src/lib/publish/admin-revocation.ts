import { accountScope } from "@/lib/auth/scope";
import { recordDocumentChanges } from "@/lib/metadata/revisions";
import type { Database } from "better-sqlite3";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { metadataDb } from "@/lib/metadata/db";
import { invalidatePublishedToken } from "./publication-resolution";
import { publicationAbsent } from "./publication-scope";

/** Revoke a known token without resolving or returning any private content.
 * Current admin authority and owner deactivation are checked in the write
 * transaction, including when the request's earlier admission is stale. */
export function revokeInactivePublication(actor: AuthContext, token: string, db: Database = metadataDb(), now = Date.now()): void {
  db.transaction(() => {
    requireAdmin(actor, db, now);
    const target = db.prepare("SELECT id FROM maps WHERE publish_token = ?").get(token) as { id: string } | undefined;
    const result = db.prepare(`UPDATE maps SET publish_token = NULL, published_at = NULL,
      published_theme = NULL, viewer_controls = NULL, updated_at = ?
      WHERE publish_token = ? AND owner_id IN (SELECT id FROM accounts WHERE status = 'deactivated')`)
      .run(new Date(now).toISOString(), token);
    if (result.changes !== 1) throw publicationAbsent();
    recordDocumentChanges(accountScope(actor, db), [{ kind: "map", id: target!.id }], db);
  }).immediate();
  invalidatePublishedToken(token);
}
