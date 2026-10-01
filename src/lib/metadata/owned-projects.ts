import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent, type OwnedResourceKind } from "@/lib/auth/owned-resource";
import { canReach, REACHED_PROJECTS, requirePermitted } from "@/lib/auth/reach";
import type { AccountLabel } from "./accounts";
import { metadataDb } from "./db";
import * as projects from "./projects";
export type { MemberChange, ProjectRecord } from "./projects";

type ProjectRow = Parameters<typeof projects.projectFromRow>[0];

/** A project read: the project when the acting account owns it or belongs to
 * it, else the absent refusal. */
export function getProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  if (!canReach(scope, "project", id, db)) return null;
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? projects.projectFromRow(row) : null;
}
export function requireProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const project = getProject(scope, id, db);
  if (!project) throw resourceAbsent();
  return project;
}

/** A reached project, with its owner and how the acting account stands to it. */
export interface ReachedProject extends projects.ProjectRecord {
  owner: AccountLabel;
  role: "owner" | "editor" | "viewer";
}
type ReachedProjectRow = ProjectRow & { owner_name: string; owner_sql_name: string; role: ReachedProject["role"] };
const REACHED_PROJECT_SELECT = `SELECT p.*, a.name AS owner_name, a.sql_name AS owner_sql_name,
    CASE WHEN p.owner_id = @me THEN 'owner' ELSE pp.role END AS role
  FROM projects p JOIN accounts a ON a.id = p.owner_id
  LEFT JOIN project_people pp ON pp.project_id = p.id AND pp.account_id = @me`;
const reachedProjectOf = (row: ReachedProjectRow): ReachedProject =>
  ({ ...projects.projectFromRow(row), owner: { name: row.owner_name, sqlName: row.owner_sql_name }, role: row.role });

/** The projects an account reaches, most recent first: its own, and every
 * project it belongs to, each with its owner and the account's role. */
export function listProjects(scope: AccountScope, db: Database = metadataDb()): ReachedProject[] {
  const me = requireAccountScope(scope, db);
  return (db.prepare(`${REACHED_PROJECT_SELECT} WHERE p.id IN (${REACHED_PROJECTS})
    ORDER BY p.created_at DESC, p.id DESC`).all({ me }) as ReachedProjectRow[]).map(reachedProjectOf);
}

/** The owner's own read, for what stays the owner's: filing into a project
 * and changing what it holds, until filing follows its own rules, and its
 * archive. Anyone else gets the absent refusal. */
export function requireOwnProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const row = db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(id, owner) as ProjectRow | undefined;
  if (!row) throw resourceAbsent();
  return projects.projectFromRow(row);
}
function checkFilingSource(scope: AccountScope, kind: "map" | "workflow", id: string, db: Database) {
  requireOwnedResource(scope, kind, id, db);
  const relation = kind === "map" ? "maps" : "recipes";
  const row = db.prepare(`SELECT project_id FROM ${relation} WHERE id = ?`).get(id) as { project_id: string | null };
  if (row.project_id) requireOwnedResource(scope, "project", row.project_id, db);
}
function checkMembers(scope: AccountScope, change: projects.MemberChange, db: Database) {
  requireAccountScope(scope, db);
  const groups: [OwnedResourceKind, string[]][] = [
    ["map", [...(change.addMaps ?? []), ...(change.removeMaps ?? [])]],
    ["workflow", [...(change.addRecipes ?? []), ...(change.removeRecipes ?? [])]],
    ["dataset", [...(change.addTables ?? []), ...(change.removeTables ?? [])]],
  ];
  for (const [kind, ids] of groups) for (const id of ids) {
    requireOwnedResource(scope, kind, id, db);
    if (kind === "map" || kind === "workflow") checkFilingSource(scope, kind, id, db);
  }
}
export function createProject(scope: AccountScope, input: { name: unknown; note?: unknown; members?: projects.MemberChange }, db: Database = metadataDb()): projects.ProjectRecord {
  return db.transaction(() => {
    const owner = requireAccountScope(scope, db);
    if (input.members) checkMembers(scope, input.members, db);
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name: projects.projectName(input.name),
      note: input.note === undefined ? null : projects.projectNote(input.note), createdAt: now, updatedAt: now };
    db.prepare("INSERT INTO projects (owner_id, id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(owner, project.id, project.name, project.note, now, now);
    if (input.members) projects.changeMembers(project.id, input.members, db);
    return requireOwnProject(scope, project.id, db);
  })();
}
/** Rename and note are the project owner's. */
export function updateProject(scope: AccountScope, id: string, fields: { name?: unknown; note?: unknown }, db: Database = metadataDb()) {
  return db.transaction(() => {
    if (fields.name !== undefined || fields.note === undefined) requirePermitted(scope, "project", id, "rename", db);
    if (fields.note !== undefined) requirePermitted(scope, "project", id, "note", db);
    return projects.updateProject(id, fields, db);
  })();
}
/** Dissolution is the project owner's: the contents stay, unfiled. */
export function deleteProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "project", id, "dissolve", db); return projects.deleteProject(id, db); })();
}
export function changeMembers(scope: AccountScope, id: string, change: projects.MemberChange, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnProject(scope, id, db); checkMembers(scope, change, db);
    projects.changeMembers(id, change, db);
  })();
}
export function fileMap(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb()) {
  return db.transaction(() => {
    checkFilingSource(scope, "map", id, db);
    if (projectId !== null) requireOwnProject(scope, projectId, db);
    projects.fileMap(id, projectId, db);
  })();
}
export function fileRecipe(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb()) {
  return db.transaction(() => {
    checkFilingSource(scope, "workflow", id, db);
    if (projectId !== null) requireOwnProject(scope, projectId, db);
    projects.fileRecipe(id, projectId, db);
  })();
}
export function fileTable(scope: AccountScope, id: string, projectId: string, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnedResource(scope, "dataset", id, db); requireOwnProject(scope, projectId, db);
    projects.fileTable(id, projectId, db);
  })();
}
/** What a reached project holds, whoever owns it: every map, workflow-origin
 * workflow and dataset filed there. */
export function projectMemberIds(scope: AccountScope, id: string, db: Database = metadataDb()) {
  requireProject(scope, id, db);
  const ids = (sql: string) => (db.prepare(sql).all(id) as { id: string }[]).map(row => row.id);
  return {
    maps: ids("SELECT id FROM maps WHERE project_id = ? ORDER BY created_at DESC"),
    recipes: ids("SELECT id FROM recipes WHERE project_id = ? AND origin = 'workflow' ORDER BY created_at DESC, id DESC"),
    tables: ids(`SELECT t.id FROM data_tables t JOIN project_datasets pd ON pd.table_id = t.id
      WHERE pd.project_id = ? ORDER BY t.created_at DESC, t.name`),
  };
}
/** Per reached project, what it holds, whoever owns it: everything filed in a
 * project the account reaches is within its reach, and nothing else is
 * counted. */
export function projectMemberCounts(scope: AccountScope, db: Database = metadataDb()) {
  const me = requireAccountScope(scope, db);
  const counts = new Map<string, { maps: number; publishedMaps: number; recipes: number; tables: number }>();
  const entry = (id: string) => { let value = counts.get(id); if (!value) { value = { maps: 0, publishedMaps: 0, recipes: 0, tables: 0 }; counts.set(id, value); } return value; };
  const maps = db.prepare(`SELECT m.project_id AS id, COUNT(*) AS n, SUM(CASE WHEN m.publish_token IS NOT NULL THEN 1 ELSE 0 END) AS published
    FROM maps m WHERE m.project_id IN (${REACHED_PROJECTS}) GROUP BY m.project_id`).all({ me }) as { id: string; n: number; published: number }[];
  for (const row of maps) { const value = entry(row.id); value.maps = row.n; value.publishedMaps = row.published; }
  const recipes = db.prepare(`SELECT r.project_id AS id, COUNT(*) AS n FROM recipes r
    WHERE r.project_id IN (${REACHED_PROJECTS}) AND r.origin = 'workflow' GROUP BY r.project_id`).all({ me }) as { id: string; n: number }[];
  for (const row of recipes) entry(row.id).recipes = row.n;
  const tables = db.prepare(`SELECT pd.project_id AS id, COUNT(*) AS n FROM project_datasets pd
    WHERE pd.project_id IN (${REACHED_PROJECTS}) GROUP BY pd.project_id`).all({ me }) as { id: string; n: number }[];
  for (const row of tables) entry(row.id).tables = row.n;
  return counts;
}
