import { recordDocumentChanges } from "./revisions";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { requirePermitted } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { accountLabels, type AccountLabel } from "./accounts";
import { metadataDb } from "./db";
import { throughTransferGate } from "./ownership-transfer";

/**
 * Transfer: the one change of ownership any surface permits, for a project,
 * a map or a workflow, always the owner's own act.
 *
 * Each transfer runs in one write transaction: the owner's authority, the
 * recipient's eligibility, the ownership update through the gate, a
 * project's role adjustments and the gate's closure commit together, or
 * nothing does. The recipient is named by their SQL name and must be an
 * active account. A project goes to one of its members, who leaves the member
 * list while the previous owner stays on as an editor. A map or workflow goes
 * to someone who already reaches it through the project it is filed in, so an
 * unfiled one is filed first; it keeps its SQL home, and everything that
 * hangs off it stays where it is. Datasets and connections have no transfer.
 */

export interface TransferResult {
  id: string;
  /** The new owner. */
  owner: AccountLabel;
}

/** What the request names as the new owner: a SQL name. */
function recipientName(to: unknown): string {
  if (typeof to !== "string" || to.trim() === "") {
    throw new ApiError("invalid_request", '"to" must be the SQL name of the new owner.', 400);
  }
  return to.trim();
}

function result(id: string, owner: string, db: Database): TransferResult {
  return { id, owner: accountLabels([owner], db).get(owner)! };
}

/** Hand a project to one of its active members. */
export function transferProject(scope: AccountScope, id: string, to: unknown, db: Database = metadataDb()): TransferResult {
  const name = recipientName(to);
  return db.transaction(() => {
    const project = requirePermitted(scope, "project", id, "transfer", db);
    const recipient = db.prepare(`SELECT a.id FROM project_people pp JOIN accounts a ON a.id = pp.account_id
      WHERE pp.project_id = ? AND a.sql_name = ? AND a.status = 'active'`).get(project.parentId, name) as { id: string } | undefined;
    if (!recipient) throw new ApiError("invalid_request", "Transfer a project only to one of its active members.", 400);
    throughTransferGate({ kind: "project", id: project.parentId, from: project.ownerId, to: recipient.id }, db, () => {
      db.prepare("DELETE FROM project_people WHERE project_id = ? AND account_id = ?").run(project.parentId, recipient.id);
      db.prepare("UPDATE projects SET owner_id = ? WHERE id = ?").run(recipient.id, project.parentId);
      db.prepare("INSERT INTO project_people (project_id, account_id, role, added_at) VALUES (?, ?, 'editor', ?)")
        .run(project.parentId, project.ownerId, new Date().toISOString());
    });
    return result(project.parentId, recipient.id, db);
  }).immediate();
}

const FILED = {
  map: { table: "maps", noun: "map" },
  workflow: { table: "recipes", noun: "workflow" },
} as const;

/** Hand a map or workflow to another active person who already reaches it
 * through its project: that project's owner or one of its people. */
function transferFiled(kind: keyof typeof FILED, scope: AccountScope, id: string, to: unknown, db: Database): TransferResult {
  const name = recipientName(to);
  const { table, noun } = FILED[kind];
  return db.transaction(() => {
    const resource = requirePermitted(scope, kind, id, "transfer", db);
    if (resource.projectId === null) {
      throw new ApiError("invalid_request", `File the ${noun} in a project first: only someone who already reaches it can receive it.`, 400);
    }
    const recipient = db.prepare(`SELECT a.id FROM accounts a
      WHERE a.sql_name = @name AND a.status = 'active' AND a.id <> @owner
        AND (a.id = (SELECT owner_id FROM projects WHERE id = @project)
          OR EXISTS (SELECT 1 FROM project_people pp WHERE pp.project_id = @project AND pp.account_id = a.id))`)
      .get({ name, owner: resource.ownerId, project: resource.projectId }) as { id: string } | undefined;
    if (!recipient) throw new ApiError("invalid_request", `Transfer a ${noun} only to another active person who already reaches it.`, 400);
    throughTransferGate({ kind, id: resource.parentId, from: resource.ownerId, to: recipient.id }, db, () => {
      db.prepare(`UPDATE ${table} SET owner_id = ? WHERE id = ?`).run(recipient.id, resource.parentId);
    });
    recordDocumentChanges(scope, [{ kind, id: resource.parentId }], db);
    return result(resource.parentId, recipient.id, db);
  }).immediate();
}

export function transferMap(scope: AccountScope, id: string, to: unknown, db: Database = metadataDb()): TransferResult {
  return transferFiled("map", scope, id, to, db);
}

export function transferWorkflow(scope: AccountScope, id: string, to: unknown, db: Database = metadataDb()): TransferResult {
  return transferFiled("workflow", scope, id, to, db);
}
