import { metadataDb } from "./db";
import { requireProject } from "./projects";
import { ApiError } from "@/lib/api/errors";

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
}

/** Bound enumeration inside the metadata query before inspecting artifacts. */
export function catalogueRecords(query: CatalogueQuery) {
  const db = metadataDb();
  if (query.project && query.project !== "none") requireProject(query.project);
  const predicates: string[] = [];
  const args: string[] = [];
  if (query.names) {
    const found = db.prepare(`SELECT name FROM data_tables WHERE name IN (${query.names.map(() => "?").join(",")})`).all(...query.names) as { name: string }[];
    if (found.length !== query.names.length) throw new ApiError("not_found", "A requested table is unavailable.", 404);
    predicates.push(`t.name IN (${query.names.map(() => "?").join(",")})`);
    args.push(...query.names);
  }
  if (query.project === "none") predicates.push("NOT EXISTS (SELECT 1 FROM project_datasets p WHERE p.table_id = t.id)");
  else if (query.project) {
    predicates.push("EXISTS (SELECT 1 FROM project_datasets p WHERE p.table_id = t.id AND p.project_id = ?)");
    args.push(query.project);
  }
  const where = predicates.length ? " WHERE " + predicates.join(" AND ") : "";
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM data_tables t${where}`).get(...args) as { total: number }).total;
  if (query.after !== undefined) { predicates.push("t.name > ?"); args.push(query.after); }
  const paged = predicates.length ? " WHERE " + predicates.join(" AND ") : "";
  const rows = db.prepare(`SELECT t.id, t.name, t.file, t.row_count, t.geometry_column, t.geometry_type, t.crs_assumed
    FROM data_tables t${paged} ORDER BY t.name LIMIT ?`).all(...args, query.limit + 1) as CatalogueRecord[];
  return { records: rows.slice(0, query.limit), total, more: rows.length > query.limit };
}
