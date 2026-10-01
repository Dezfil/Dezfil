import { metadataDb } from "./db";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { REACHED_PROJECTS, requireReachable } from "@/lib/auth/reach";

export interface CatalogueQuery {
  after?: string;
  names?: string[];
  project?: string;
  limit: number;
  columns: number;
  columnOffset: number;
}
export interface CatalogueRecord {
  id: string; name: string; file: string; row_count: number;
  geometry_column: string | null; geometry_type: string | null; crs_assumed: number;
  /** The name the caller would type: plain for their own, `<sql name>.<name>`
   * for someone else's. Unique among what one caller reaches. */
  qualified: string;
  owner_name: string; owner_sql_name: string;
}

/**
 * The datasets the caller reaches (their own, and every dataset filed in a
 * project they own or belong to), keyed and ordered by the name the caller
 * would type. That name is unique within one caller's reach, so the cursor
 * over it visits two same-named datasets of different owners once each, and
 * `names` addresses another owner's dataset by its qualified name. Bound
 * enumeration inside the metadata query before inspecting artifacts.
 */
export function catalogueRecords(scope: AccountScope, query: CatalogueQuery) {
  const db = metadataDb();
  const me = requireAccountScope(scope, db);
  if (query.project && query.project !== "none") requireReachable(scope, "project", query.project, db);
  const reached = `SELECT t.id, t.name, t.file, t.row_count, t.geometry_column, t.geometry_type, t.crs_assumed, t.owner_id,
      CASE WHEN t.owner_id = @me THEN t.name ELSE a.sql_name || '.' || t.name END AS qualified,
      a.name AS owner_name, a.sql_name AS owner_sql_name
    FROM data_tables t JOIN accounts a ON a.id = t.owner_id
    WHERE t.owner_id = @me OR t.id IN (SELECT table_id FROM project_datasets WHERE project_id IN (${REACHED_PROJECTS}))`;
  const predicates: string[] = [];
  const args: Record<string, unknown> = { me };
  if (query.names) {
    args.names = JSON.stringify(query.names);
    const found = db.prepare(`SELECT qualified FROM (${reached}) WHERE qualified IN (SELECT value FROM json_each(@names))`).all(args);
    if (found.length !== query.names.length) throw resourceAbsent();
    predicates.push("r.qualified IN (SELECT value FROM json_each(@names))");
  }
  if (query.project === "none") {
    predicates.push(`r.owner_id = @me AND NOT EXISTS (SELECT 1 FROM project_datasets p WHERE p.table_id = r.id AND p.project_id IN (${REACHED_PROJECTS}))`);
  } else if (query.project) {
    predicates.push("EXISTS (SELECT 1 FROM project_datasets p WHERE p.table_id = r.id AND p.project_id = @project)");
    args.project = query.project;
  }
  const where = (extra: string[]) => (extra.length ? " WHERE " + extra.join(" AND ") : "");
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM (${reached}) r${where(predicates)}`).get(args) as { total: number }).total;
  const paged = [...predicates];
  if (query.after !== undefined) { paged.push("r.qualified > @after"); args.after = query.after; }
  args.limit = query.limit + 1;
  const rows = db.prepare(`SELECT r.* FROM (${reached}) r${where(paged)} ORDER BY r.qualified LIMIT @limit`).all(args) as CatalogueRecord[];
  return { records: rows.slice(0, query.limit), total, more: rows.length > query.limit };
}
