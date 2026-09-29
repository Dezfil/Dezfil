import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent, type OwnedResourceKind } from "@/lib/auth/owned-resource";
import { metadataDb } from "./db";
import * as projects from "./projects";
export type { MemberChange, ProjectRecord } from "./projects";

export function getProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const row = db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(id, owner) as Parameters<typeof projects.projectFromRow>[0] | undefined;
  return row ? projects.projectFromRow(row) : null;
}
export function requireProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const project = getProject(scope, id, db);
  if (!project) throw resourceAbsent();
  return project;
}
export function listProjects(scope: AccountScope, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  return (db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC, id DESC").all(owner) as Parameters<typeof projects.projectFromRow>[0][]).map(projects.projectFromRow);
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
    return requireProject(scope, project.id, db);
  })();
}
export function updateProject(scope: AccountScope, id: string, fields: { name?: unknown; note?: unknown }, db: Database = metadataDb()) {
  return db.transaction(() => { requireProject(scope, id, db); return projects.updateProject(id, fields, db); })();
}
export function deleteProject(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requireProject(scope, id, db); return projects.deleteProject(id, db); })();
}
export function changeMembers(scope: AccountScope, id: string, change: projects.MemberChange, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireProject(scope, id, db); checkMembers(scope, change, db);
    projects.changeMembers(id, change, db);
  })();
}
export function fileMap(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb()) {
  return db.transaction(() => {
    checkFilingSource(scope, "map", id, db);
    if (projectId !== null) requireProject(scope, projectId, db);
    projects.fileMap(id, projectId, db);
  })();
}
export function fileRecipe(scope: AccountScope, id: string, projectId: string | null, db: Database = metadataDb()) {
  return db.transaction(() => {
    checkFilingSource(scope, "workflow", id, db);
    if (projectId !== null) requireProject(scope, projectId, db);
    projects.fileRecipe(id, projectId, db);
  })();
}
export function fileTable(scope: AccountScope, id: string, projectId: string, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnedResource(scope, "dataset", id, db); requireProject(scope, projectId, db);
    projects.fileTable(id, projectId, db);
  })();
}
export function projectMemberIds(scope: AccountScope, id: string, db: Database = metadataDb()) {
  requireProject(scope, id, db);
  const owner = requireAccountScope(scope, db);
  const ids = (sql: string) => (db.prepare(sql).all(id, owner) as { id: string }[]).map(row => row.id);
  return {
    maps: ids("SELECT id FROM maps WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC"),
    recipes: ids("SELECT id FROM recipes WHERE project_id = ? AND owner_id = ? AND origin = 'workflow' ORDER BY created_at DESC, id DESC"),
    tables: ids(`SELECT t.id FROM data_tables t JOIN project_datasets pd ON pd.table_id = t.id
      WHERE pd.project_id = ? AND t.owner_id = ? ORDER BY t.created_at DESC, t.name`),
  };
}
export function projectMemberCounts(scope: AccountScope, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const counts = new Map<string, { maps: number; publishedMaps: number; recipes: number; tables: number }>();
  const entry = (id: string) => { let value = counts.get(id); if (!value) { value = { maps: 0, publishedMaps: 0, recipes: 0, tables: 0 }; counts.set(id, value); } return value; };
  const maps = db.prepare(`SELECT m.project_id AS id, COUNT(*) AS n, SUM(CASE WHEN m.publish_token IS NOT NULL THEN 1 ELSE 0 END) AS published
    FROM maps m JOIN projects p ON p.id = m.project_id WHERE p.owner_id = ? AND m.owner_id = ? GROUP BY m.project_id`).all(owner, owner) as { id: string; n: number; published: number }[];
  for (const row of maps) { const value = entry(row.id); value.maps = row.n; value.publishedMaps = row.published; }
  const recipes = db.prepare(`SELECT r.project_id AS id, COUNT(*) AS n FROM recipes r JOIN projects p ON p.id = r.project_id
    WHERE p.owner_id = ? AND r.owner_id = ? AND r.origin = 'workflow' GROUP BY r.project_id`).all(owner, owner) as { id: string; n: number }[];
  for (const row of recipes) entry(row.id).recipes = row.n;
  const tables = db.prepare(`SELECT pd.project_id AS id, COUNT(*) AS n FROM project_datasets pd JOIN projects p ON p.id = pd.project_id
    JOIN data_tables t ON t.id = pd.table_id WHERE p.owner_id = ? AND t.owner_id = ? GROUP BY pd.project_id`).all(owner, owner) as { id: string; n: number }[];
  for (const row of tables) entry(row.id).tables = row.n;
  return counts;
}
