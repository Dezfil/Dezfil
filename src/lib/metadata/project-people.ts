import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { requirePermitted, requireReachable } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "./db";
import { personLabel } from "./accounts";

/**
 * A project's people: its owner and the members the owner gave a role.
 *
 * The owner reads the roster; members read the owner and their own role.
 * Adding a person, changing a role and removing another person are the project
 * owner's alone. A member may end their own grant. A person is named by their
 * SQL name, the one fact about an account other people already see. The store
 * keeps the owner out of the member rows; a membership change is read again
 * by the kernel on the member's next request, so nobody signs out for it.
 */

export type PersonRole = "viewer" | "editor";
export interface ProjectPerson {
  name: string;
  sqlName: string;
  /** The version of the person's picture, present while they have one. */
  pictureVersion?: string;
  role: "owner" | PersonRole;
  /** The account is not active: a member's grant is inert until reactivation. */
  deactivated: boolean;
}

/** The one refusal for a person who cannot be given a role: deactivated, an
 * invitation never redeemed, or nobody at all, all alike. */
export const NO_ACTIVE_PERSON = "No active person has that SQL name.";
export const OWNER_NOT_MEMBER = "The project's owner is never its member.";

type PersonRow = { name: string; sql_name: string; picture_version: string | null; status: string; role: ProjectPerson["role"] };
const person = (row: PersonRow): ProjectPerson =>
  ({ ...personLabel(row.name, row.sql_name, row.picture_version), role: row.role, deactivated: row.status !== "active" });

/** The owner first, then the members by name; `only` narrows the members to
 * one account. */
function peopleOf(projectId: string, ownerId: string, db: Database, only?: string): ProjectPerson[] {
  const owner = db.prepare("SELECT name, sql_name, picture_version, status, 'owner' AS role FROM accounts WHERE id = ?").get(ownerId) as PersonRow;
  const members = db.prepare(`SELECT a.name, a.sql_name, a.picture_version, a.status, pp.role FROM project_people pp
    JOIN accounts a ON a.id = pp.account_id WHERE pp.project_id = @project AND (@only IS NULL OR pp.account_id = @only)
    ORDER BY a.name COLLATE NOCASE, a.sql_name`).all({ project: projectId, only: only ?? null }) as PersonRow[];
  return [owner, ...members].map(person);
}

/** The people of a reached project, as its reader may know them. The roster
 * and its deactivation marks are the project owner's to manage, so the owner
 * reads it whole, the owner first, then its members by name; anyone else who
 * reaches the project reads its owner and themselves with their own role. */
export function listProjectPeople(scope: AccountScope, projectId: string, db: Database = metadataDb()): ProjectPerson[] {
  return db.transaction(() => {
    const project = requireReachable(scope, "project", projectId, db);
    return project.relation === "owner"
      ? peopleOf(project.parentId, project.ownerId, db)
      : peopleOf(project.parentId, project.ownerId, db, scope.accountId);
  })();
}

/** Give a person a role on the project, adding them or changing the role they
 * hold. Only an active account other than the owner can hold one. */
export function setProjectPerson(scope: AccountScope, projectId: string, sqlName: string, role: PersonRole,
  db: Database = metadataDb()): ProjectPerson[] {
  return db.transaction(() => {
    const project = requirePermitted(scope, "project", projectId, "membership", db);
    const account = db.prepare("SELECT id FROM accounts WHERE sql_name = ? AND status = 'active'").get(sqlName) as
      { id: string } | undefined;
    if (!account) throw new ApiError("invalid_request", NO_ACTIVE_PERSON, 400);
    if (account.id === project.ownerId) throw new ApiError("invalid_request", OWNER_NOT_MEMBER, 400);
    db.prepare(`INSERT INTO project_people (project_id, account_id, role, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id, account_id) DO UPDATE SET role = excluded.role`)
      .run(project.parentId, account.id, role, new Date().toISOString());
    return peopleOf(project.parentId, project.ownerId, db);
  }).immediate();
}

/** Take a person off the project, a deactivated member included. Removing
 * someone who holds no role there changes nothing. Nothing they own is
 * deleted, unfiled or reassigned. */
export function removeProjectPerson(scope: AccountScope, projectId: string, sqlName: string,
  db: Database = metadataDb()): ProjectPerson[] {
  return db.transaction(() => {
    const project = requirePermitted(scope, "project", projectId, "membership", db);
    const account = db.prepare("SELECT id FROM accounts WHERE sql_name = ?").get(sqlName) as { id: string } | undefined;
    if (account) endGrant(project.parentId, account.id, db);
    return peopleOf(project.parentId, project.ownerId, db);
  }).immediate();
}

function endGrant(projectId: string, accountId: string, db: Database): void {
  db.prepare("DELETE FROM project_people WHERE project_id = ? AND account_id = ?").run(projectId, accountId);
}

/** Departure ends only the credential holder's grant, including under a frozen
 * owner. Reach rechecks the active account and hides absent/non-member projects.
 * No roster is read, and no document revision or filing changes. */
export function leaveProject(scope: AccountScope, projectId: string, db: Database = metadataDb()): { left: true } {
  return db.transaction(() => {
    const project = requireReachable(scope, "project", projectId, db);
    if (project.relation === "owner") throw new ApiError("project_owner_cannot_leave",
      "The project's owner cannot leave. Transfer or delete the project instead.", 409);
    endGrant(project.parentId, scope.accountId, db);
    return { left: true as const };
  }).immediate();
}
