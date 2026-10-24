import { compareDocumentRevision } from "./revisions";
import { documentResults } from "./document-results";
import { recordFiling, filedDocuments, memberDocuments, requireFilingRevisions } from "./filing-recording";
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { canReach, REACHED_PROJECTS, requireFilingAddition, requireFilingRemoval, requirePermitted, requireReachable,
  type FilingKind } from "@/lib/auth/reach";
import { personLabel, type PersonLabel } from "./accounts";
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
  owner: PersonLabel;
  role: "owner" | "editor" | "viewer";
}
type ReachedProjectRow = ProjectRow & { owner_name: string; owner_sql_name: string; owner_picture_version: string | null; role: ReachedProject["role"] };
const REACHED_PROJECT_SELECT = `SELECT p.*, a.name AS owner_name, a.sql_name AS owner_sql_name, a.picture_version AS owner_picture_version,
    CASE WHEN p.owner_id = @me THEN 'owner' ELSE pp.role END AS role
  FROM projects p JOIN accounts a ON a.id = p.owner_id
  LEFT JOIN project_people pp ON pp.project_id = p.id AND pp.account_id = @me`;
const reachedProjectOf = (row: ReachedProjectRow): ReachedProject =>
  ({ ...projects.projectFromRow(row), owner: personLabel(row.owner_name, row.owner_sql_name, row.owner_picture_version), role: row.role });

/** The projects an account reaches, most recent first: its own, and every
 * project it belongs to, each with its owner and the account's role. */
export function listProjects(scope: AccountScope, db: Database = metadataDb()): ReachedProject[] {
  const me = requireAccountScope(scope, db);
  return (db.prepare(`${REACHED_PROJECT_SELECT} WHERE p.id IN (${REACHED_PROJECTS})
    ORDER BY p.created_at DESC, p.id DESC`).all({ me }) as ReachedProjectRow[]).map(reachedProjectOf);
}

/** The owner's own read, for what stays the owner's: the project's archive.
 * Anyone else gets the absent refusal. */
export function requireOwnProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const row = db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(id, owner) as ProjectRow | undefined;
  if (!row) throw resourceAbsent();
  return projects.projectFromRow(row);
}

type FilingGroup = [FilingKind, string[], string[]];
const FILED_IN: Record<FilingKind, string> = {
  map: "SELECT project_id AS project FROM maps WHERE id = ?",
  workflow: "SELECT project_id AS project FROM recipes WHERE id = ?",
  dataset: "SELECT project_id AS project FROM project_datasets WHERE table_id = ?",
};
const filedIn = (kind: FilingKind, id: string, db: Database) =>
  (db.prepare(FILED_IN[kind]).all(id) as { project: string | null }[]).map(row => row.project).filter((p): p is string => p !== null);
const OWNED: Record<FilingKind, string> = {
  map: "SELECT 1 FROM maps WHERE id = ? AND owner_id = ?",
  workflow: "SELECT 1 FROM recipes WHERE id = ? AND owner_id = ?",
  dataset: "SELECT 1 FROM data_tables WHERE id = ? AND owner_id = ?",
};

/** A map or workflow filed at most once: filing it into a project takes it
 * out of the one it was in, which its owner may always do. */
function requireMove(scope: AccountScope, kind: "map" | "workflow", id: string, projectId: string | null, db: Database) {
  for (const current of filedIn(kind, id, db)) if (current !== projectId) requireFilingRemoval(scope, kind, id, current, db);
}

/**
 * The checks of one compound filing change, by the kernel's named rules:
 * adding needs the destination's permission (its owner, or an editor filing
 * their own resource, into a project whose owner is active); removing is the
 * resource owner's from any project, member or not, and the project owner's
 * for anything filed in their project. Removing what is not filed in the
 * project changes nothing, for anyone who reaches it. A caller who does not
 * reach the project may only withdraw their own resources filed in it; to
 * anyone else the project is absent.
 */
function checkMembers(scope: AccountScope, projectId: string, change: projects.MemberChange, db: Database) {
  const me = requireAccountScope(scope, db);
  const groups: FilingGroup[] = [
    ["map", change.addMaps ?? [], change.removeMaps ?? []],
    ["workflow", change.addRecipes ?? [], change.removeRecipes ?? []],
    ["dataset", change.addTables ?? [], change.removeTables ?? []],
  ];
  if (!canReach(scope, "project", projectId, db)) {
    const ownFiledHere = (kind: FilingKind, id: string) =>
      filedIn(kind, id, db).includes(projectId) && db.prepare(OWNED[kind]).get(id, me) !== undefined;
    const withdrawsOwn = groups.some(([, , removed]) => removed.length > 0) &&
      groups.every(([kind, added, removed]) => added.length === 0 && removed.every(id => ownFiledHere(kind, id)));
    if (!withdrawsOwn) throw resourceAbsent();
  }
  for (const [kind, added, removed] of groups) {
    for (const id of added) {
      requireFilingAddition(scope, kind, id, projectId, db);
      if (kind !== "dataset") requireMove(scope, kind, id, projectId, db);
    }
    for (const id of removed) {
      if (filedIn(kind, id, db).includes(projectId)) requireFilingRemoval(scope, kind, id, projectId, db);
      else requireReachable(scope, kind, id, db);
    }
  }
}
export function createProject(scope: AccountScope, input: { name: unknown; note?: unknown; members?: projects.MemberChange }, db: Database = metadataDb()): projects.ProjectRecord {
  return db.transaction(() => {
    const owner = requireAccountScope(scope, db);
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name: projects.projectName(input.name),
      note: input.note === undefined ? null : projects.projectNote(input.note), createdAt: now, updatedAt: now };
    db.prepare("INSERT INTO projects (owner_id, id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(owner, project.id, project.name, project.note, now, now);
    if (input.members) {
      checkMembers(scope, project.id, input.members, db);
      requireFilingRevisions(input.members, db);
      recordFiling(scope, memberDocuments(input.members), () => projects.changeMembers(project.id, input.members!, db), db);
    }
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
  return db.transaction(() => { requirePermitted(scope, "project", id, "dissolve", db); return recordFiling(scope, filedDocuments(id, db), () => projects.deleteProject(id, db), db); })();
}
/** One compound filing change, all of it or none. */
export function changeMembers(scope: AccountScope, id: string, change: projects.MemberChange, db: Database = metadataDb()) {
  return db.transaction(() => {
    checkMembers(scope, id, change, db);
    requireFilingRevisions(change, db);
    recordFiling(scope, memberDocuments(change), () => projects.changeMembers(id, change, db), db);
    return documentResults(scope, memberDocuments(change), db);
  })();
}
/** File a map into a project, or out of the one it is in (null). */
export function fileMap(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb(), options: { expectedRevision?: unknown } = {}) {
  return db.transaction(() => {
    requireReachable(scope, "map", id, db);
    if (projectId !== null) requireFilingAddition(scope, "map", id, projectId, db);
    requireMove(scope, "map", id, projectId, db);
    compareDocumentRevision({ kind: "map", id, expectedRevision: options.expectedRevision }, db);
    recordFiling(scope, [{ kind: "map", id }], () => projects.fileMap(id, projectId, db), db);
  })();
}
/** File a workflow into a project, or out of the one it is in (null). */
export function fileRecipe(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb(), options: { expectedRevision?: unknown } = {}) {
  return db.transaction(() => {
    requireReachable(scope, "workflow", id, db);
    if (projectId !== null) requireFilingAddition(scope, "workflow", id, projectId, db);
    requireMove(scope, "workflow", id, projectId, db);
    compareDocumentRevision({ kind: "workflow", id, expectedRevision: options.expectedRevision }, db);
    recordFiling(scope, [{ kind: "workflow", id }], () => projects.fileRecipe(id, projectId, db), db);
  })();
}
export function fileTable(scope: AccountScope, id: string, projectId: string, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireFilingAddition(scope, "dataset", id, projectId, db);
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
