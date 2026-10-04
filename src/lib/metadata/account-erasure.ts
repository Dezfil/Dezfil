import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { normalizeEmail } from "./accounts";

/** Internal erasure stages require an explicit store and never grant a private
 * read. The acceptance coordinator must persist deleting before calling them. */
export function requireDeletingAccount(accountId: string, db: Database): void {
  if (!db.inTransaction) throw new Error("Account erasure requires a transaction.");
  const row = db.prepare("SELECT status FROM accounts WHERE id = ?").get(accountId) as { status: string } | undefined;
  if (row?.status !== "deleting") throw new Error("Account erasure requires the stored deleting state.");
}

export function eraseAccountCredentials(accountId: string, db: Database): void {
  db.transaction(() => {
    requireDeletingAccount(accountId, db);
    // Former emails have no account reference. Preserve all other currently
    // bound emails, including invitations, deactivated and pending accounts.
    const emails = db.prepare("SELECT email FROM accounts WHERE id <> ? AND email IS NOT NULL").all(accountId) as { email: string }[];
    const retained = emails.map(({ email }) => `account:${createHash("sha256").update(normalizeEmail(email)).digest("hex")}`);
    db.prepare(`DELETE FROM auth_login_limits WHERE bucket LIKE 'account:%'
      AND bucket NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(retained));
    for (const table of ["auth_sessions", "auth_tokens", "auth_links", "account_preferences"]) {
      db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
    }
    // Profile and email reservation survive until successful finalization.
    db.prepare("UPDATE accounts SET password_hash = NULL, last_sign_in_at = NULL WHERE id = ?").run(accountId);
  }).immediate();
}
