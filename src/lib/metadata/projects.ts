import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "./db";
export { createProject } from "./owned-projects";

/**
 * Projects: the optional named set over maps, recipes and data tables.
 * This module owns the project rows and every membership read and write;
 * the maps, recipes and tables repositories keep owning their own rows. A
 * map or recipe carries at most one project; a dataset can belong to
 * several. Deleting a project dissolves the set and deletes nothing.
 *
 * The map's reference deliberately does NOT ride `MapRecord` — the same
 * exclusion `published_theme` and `viewer_controls` already use — so the
 * published snapshot's revision never observes a membership change and
 * published payloads stay byte-identical.
 */

export interface ProjectRecord {
  id: string;
  name: string;
  /** The project's note; null = none. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function projectFromRow(r: ProjectRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getProject(
  id: string,
  db: Database = metadataDb(),
): ProjectRecord | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | ProjectRow
    | undefined;
  return row ? projectFromRow(row) : null;
}

/** Every map's project, for the overview listing: map id → project id. */
export function mapProjectIds(
  db: Database = metadataDb(),
): Map<string, string> {
  const rows = db
    .prepare(`SELECT id, project_id FROM maps WHERE project_id IS NOT NULL`)
    .all() as { id: string; project_id: string }[];
  return new Map(rows.map((r) => [r.id, r.project_id]));
}

/** One map's project; null when unfiled or unknown. */
export function mapProjectId(
  mapId: string,
  db: Database = metadataDb(),
): string | null {
  const row = db
    .prepare(`SELECT project_id FROM maps WHERE id = ?`)
    .get(mapId) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

/** Every table's projects, for listings: table id → project ids. The
 * order is stable but carries no meaning (two memberships added in the
 * same millisecond cannot be ordered honestly). Tables with none are
 * absent. */
export function tableProjectIds(
  db: Database = metadataDb(),
): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT table_id, project_id FROM project_datasets
       ORDER BY added_at, project_id`,
    )
    .all() as { table_id: string; project_id: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.table_id);
    if (list) list.push(r.project_id);
    else out.set(r.table_id, [r.project_id]);
  }
  return out;
}

/** The recipes convention: trimmed, non-empty,
 * duplicates allowed, bounded. */
export const PROJECT_NAME_MAX = 120;

export function projectName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ApiError("invalid_request", '"name" must be a non-empty string.', 400);
  }
  const name = raw.trim();
  if (name.length > PROJECT_NAME_MAX) {
    throw new ApiError(
      "invalid_request",
      `"name" must be at most ${PROJECT_NAME_MAX} characters.`,
      400,
    );
  }
  return name;
}

export function projectNote(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiError("invalid_request", '"note" must be a string or null.', 400);
  }
  // No length cap: the map note carries none either, and inventing one
  // here would be an unruled product semantic (found at review).
  const note = raw.trim();
  return note === "" ? null : note;
}

export function requireProject(
  id: string,
  db: Database = metadataDb(),
): ProjectRecord {
  const project = getProject(id, db);
  if (!project) throw new ApiError("not_found", `No project with id ${id}.`, 404);
  return project;
}

export function listProjects(db: Database = metadataDb()): ProjectRecord[] {
  // Most recent first, the maps convention.
  return (
    db
      .prepare(`SELECT * FROM projects ORDER BY created_at DESC, id DESC`)
      .all() as ProjectRow[]
  ).map(projectFromRow);
}

/** One compound membership change: everything
 * applies in one transaction or nothing does. */
export interface MemberChange {
  addMaps?: string[];
  removeMaps?: string[];
  addRecipes?: string[];
  removeRecipes?: string[];
  addTables?: string[];
  removeTables?: string[];
}

/** The recipes' strictly-advancing stamp (their nextStamp precedent):
 * "advances" must be strictly true for a sort by it to be stable, even
 * when two changes share a millisecond (found at review). */
function stampAfter(previous: string, at: string): string {
  const wanted = Date.parse(at);
  const after = Date.parse(previous) + 1;
  return new Date(
    Number.isFinite(after) ? Math.max(wanted, after) : wanted,
  ).toISOString();
}

function touchProject(id: string, at: string, db: Database): void {
  const row = db
    .prepare(`SELECT updated_at FROM projects WHERE id = ?`)
    .get(id) as { updated_at: string } | undefined;
  if (!row) return;
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(
    stampAfter(row.updated_at, at),
    id,
  );
}

/** File a map: at most one project, so filing moves it. The member's own
 * updated_at is deliberately untouched — filing is not an edit. Bumps the
 * target and, on a move, the source project. */
export function fileMap(
  mapId: string,
  projectId: string | null,
  db: Database = metadataDb(),
  at = new Date().toISOString(),
): void {
  const row = db.prepare(`SELECT project_id FROM maps WHERE id = ?`).get(mapId) as
    | { project_id: string | null }
    | undefined;
  if (!row) throw new ApiError("not_found", `No map with id ${mapId}.`, 404);
  if (row.project_id === projectId) return;
  db.prepare(`UPDATE maps SET project_id = ? WHERE id = ?`).run(projectId, mapId);
  if (row.project_id) touchProject(row.project_id, at, db);
  if (projectId) touchProject(projectId, at, db);
}

/** File a workflow-origin recipe — the same contract as fileMap. A
 * builder-origin recipe can still be removed from legacy or directly seeded
 * state, but cannot be added to a project. */
export function fileRecipe(
  recipeId: string,
  projectId: string | null,
  db: Database = metadataDb(),
  at = new Date().toISOString(),
): void {
  const row = db
    .prepare(`SELECT project_id, origin FROM recipes WHERE id = ?`)
    .get(recipeId) as
    | { project_id: string | null; origin: string | null }
    | undefined;
  if (!row) throw new ApiError("not_found", `No workflow with id ${recipeId}.`, 404);
  if (projectId && row.origin !== "workflow") {
    throw new ApiError(
      "invalid_request",
      "Only workflows can be project members.",
      400,
    );
  }
  if (row.project_id === projectId) return;
  db.prepare(`UPDATE recipes SET project_id = ? WHERE id = ?`).run(
    projectId,
    recipeId,
  );
  if (row.project_id) touchProject(row.project_id, at, db);
  if (projectId) touchProject(projectId, at, db);
}

/** Add a dataset to a project (idempotent). The
 * check-then-insert stays portable and is safe inside the transaction. */
export function fileTable(
  tableId: string,
  projectId: string,
  db: Database = metadataDb(),
  at = new Date().toISOString(),
): void {
  // The project is re-checked here — the second check of spec a project
  // deleted during an import's asynchronous work answers not-found and
  // rolls the registration back, never an uncoded constraint error.
  requireProject(projectId, db);
  const table = db
    .prepare(`SELECT id FROM data_tables WHERE id = ?`)
    .get(tableId) as { id: string } | undefined;
  if (!table) throw new ApiError("not_found", `No dataset with id ${tableId}.`, 404);
  const existing = db
    .prepare(
      `SELECT 1 FROM project_datasets WHERE project_id = ? AND table_id = ?`,
    )
    .get(projectId, tableId);
  if (existing) return;
  db.prepare(
    `INSERT INTO project_datasets (project_id, table_id, added_at) VALUES (?, ?, ?)`,
  ).run(projectId, tableId, at);
  touchProject(projectId, at, db);
}

function unfileTable(
  tableId: string,
  projectId: string,
  db: Database,
  at: string,
): void {
  const gone = db
    .prepare(`DELETE FROM project_datasets WHERE project_id = ? AND table_id = ?`)
    .run(projectId, tableId);
  if (gone.changes > 0) touchProject(projectId, at, db);
}

/** Apply one compound change to a project's members — all or nothing. */
export function changeMembers(
  projectId: string,
  change: MemberChange,
  db: Database = metadataDb(),
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    requireProject(projectId, db);
    for (const id of change.addMaps ?? []) fileMap(id, projectId, db, at);
    for (const id of change.removeMaps ?? []) {
      const row = db
        .prepare(`SELECT project_id FROM maps WHERE id = ?`)
        .get(id) as { project_id: string | null } | undefined;
      if (!row) throw new ApiError("not_found", `No map with id ${id}.`, 404);
      if (row.project_id === projectId) fileMap(id, null, db, at);
    }
    for (const id of change.addRecipes ?? []) fileRecipe(id, projectId, db, at);
    for (const id of change.removeRecipes ?? []) {
      const row = db
        .prepare(`SELECT project_id FROM recipes WHERE id = ?`)
        .get(id) as { project_id: string | null } | undefined;
      if (!row) throw new ApiError("not_found", `No workflow with id ${id}.`, 404);
      if (row.project_id === projectId) fileRecipe(id, null, db, at);
    }
    for (const id of change.addTables ?? []) fileTable(id, projectId, db, at);
    for (const id of change.removeTables ?? []) {
      const table = db
        .prepare(`SELECT id FROM data_tables WHERE id = ?`)
        .get(id) as { id: string } | undefined;
      if (!table) throw new ApiError("not_found", `No dataset with id ${id}.`, 404);
      unfileTable(id, projectId, db, at);
    }
  })();
}

export function updateProject(
  id: string,
  fields: { name?: unknown; note?: unknown },
  db: Database = metadataDb(),
): ProjectRecord {
  const now = new Date().toISOString();
  return db.transaction(() => {
    requireProject(id, db);
    if (fields.name !== undefined) {
      db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(
        projectName(fields.name),
        id,
      );
      touchProject(id, now, db);
    }
    if (fields.note !== undefined) {
      db.prepare(`UPDATE projects SET note = ? WHERE id = ?`).run(
        projectNote(fields.note),
        id,
      );
      touchProject(id, now, db);
    }
    return requireProject(id, db);
  })();
}

/** Delete a project: the set dissolves and nothing else is touched.
 * Memberships cascade; map and recipe references go to null
 * by the schema's own rule. */
export function deleteProject(id: string, db: Database = metadataDb()): boolean {
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
}

/** Bump every project containing a member that is about to be deleted —
 * cascades remove the rows but cannot advance the sets' own clocks. Call
 * inside the member's deletion transaction, before the delete. */
export function touchProjectsOf(
  member: { mapId?: string; recipeId?: string; tableId?: string },
  db: Database = metadataDb(),
  at = new Date().toISOString(),
): void {
  if (member.mapId) {
    const p = mapProjectId(member.mapId, db);
    if (p) touchProject(p, at, db);
  }
  if (member.recipeId) {
    const row = db
      .prepare(`SELECT project_id FROM recipes WHERE id = ?`)
      .get(member.recipeId) as { project_id: string | null } | undefined;
    if (row?.project_id) touchProject(row.project_id, at, db);
  }
  if (member.tableId) {
    const rows = db
      .prepare(`SELECT project_id FROM project_datasets WHERE table_id = ?`)
      .all(member.tableId) as { project_id: string }[];
    for (const r of rows) touchProject(r.project_id, at, db);
  }
}

/** The listing's member facts, one query set for
 * all projects: counts by kind plus the published-map count. */
/** The project's member ids per kind, each in its kind's documented
 * listing order — the canonical order the export's manifest mapping and
 * collision suffixes ride (caller array order carries no meaning). A
 * read, never a mutation: the export preflight validates selected
 * identities against these sets before any archive work. */
export function projectMemberIds(
  projectId: string,
  db: Database = metadataDb(),
): { maps: string[]; recipes: string[]; tables: string[] } {
  requireProject(projectId, db);
  const ids = (sql: string) =>
    (db.prepare(sql).all(projectId) as { id: string }[]).map((r) => r.id);
  return {
    maps: ids(`SELECT id FROM maps WHERE project_id = ?
               ORDER BY created_at DESC`),
    recipes: ids(`SELECT id FROM recipes WHERE project_id = ? AND origin = 'workflow'
                  ORDER BY created_at DESC, id DESC`),
    tables: ids(`SELECT t.id FROM data_tables t
                 JOIN project_datasets pd ON pd.table_id = t.id
                 WHERE pd.project_id = ?
                 ORDER BY t.created_at DESC, t.name`),
  };
}

export function projectMemberCounts(db: Database = metadataDb()): Map<
  string,
  { maps: number; publishedMaps: number; recipes: number; tables: number }
> {
  const out = new Map<
    string,
    { maps: number; publishedMaps: number; recipes: number; tables: number }
  >();
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { maps: 0, publishedMaps: 0, recipes: 0, tables: 0 };
      out.set(id, e);
    }
    return e;
  };
  for (const r of db
    .prepare(
      `SELECT project_id AS id, COUNT(*) AS n,
              SUM(CASE WHEN publish_token IS NOT NULL THEN 1 ELSE 0 END) AS published
       FROM maps WHERE project_id IS NOT NULL GROUP BY project_id`,
    )
    .all() as { id: string; n: number; published: number }[]) {
    const e = entry(r.id);
    e.maps = r.n;
    e.publishedMaps = r.published;
  }
  for (const r of db
    .prepare(
      `SELECT project_id AS id, COUNT(*) AS n FROM recipes
       WHERE project_id IS NOT NULL AND origin = 'workflow' GROUP BY project_id`,
    )
    .all() as { id: string; n: number }[]) {
    entry(r.id).recipes = r.n;
  }
  for (const r of db
    .prepare(
      `SELECT project_id AS id, COUNT(*) AS n FROM project_datasets GROUP BY project_id`,
    )
    .all() as { id: string; n: number }[]) {
    entry(r.id).tables = r.n;
  }
  return out;
}
