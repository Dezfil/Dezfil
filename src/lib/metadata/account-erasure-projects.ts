import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireDeletingAccount } from "./account-erasure";
import { filedDocuments, recordFiling } from "./filing-recording";
import { deleteProject } from "./projects";

/** Internal dissolution authority for accepted deletion. The acting admin is
 * recorded, without granting them a read or impersonating the frozen owner. */
export function dissolveAccountProjects(accountId: string, actor: AccountScope, db: Database): string[] {
  return db.transaction(() => {
    requireDeletingAccount(accountId, db);
    const actorId = requireAccountScope(actor, db);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND is_admin = 1").get(actorId)) {
      throw new Error("Account dissolution requires an active admin.");
    }
    const projects = db.prepare("SELECT id FROM projects WHERE owner_id = ? ORDER BY id").all(accountId) as { id: string }[];
    for (const { id } of projects) {
      recordFiling(actor, filedDocuments(id, db), () => deleteProject(id, db), db);
    }
    db.prepare("DELETE FROM project_people WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM ownership_transfer_gate WHERE from_owner_id = ? OR to_owner_id = ?").run(accountId, accountId);
    return projects.map(p => p.id);
  }).immediate();
}
