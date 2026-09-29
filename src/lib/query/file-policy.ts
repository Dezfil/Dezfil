import { guardProjectionValues } from "./projection-policy";
import { CATALOG_COLUMNS, inspectCatalogues } from "./catalogue-policy";
import { parseSqlJson } from "./sql-json";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { qualifiedNameParts } from "./qualified-name";
import { constantArgument, constantExpression, isSqlNode, sqlText, type SqlNode } from "./sql-tree";

const REJECTION = "Queries must use named datasets. File access and engine path discovery are not accepted.";
function refuse(): never { throw new ApiError("sql_rejected", REJECTION, 400); }
// These table functions cannot bind a file, execute SQL, or reveal engine paths.
// Keep the list explicit: an engine upgrade cannot silently add a new reader.
const SAFE_TABLE_FUNCTIONS = new Set([
  "summary", "range", "generate_series", "repeat", "repeat_row", "unnest", "json_each", "json_tree",
  "st_generatepoints", "st_drivers", "duckdb_columns", "duckdb_constraints", "duckdb_dependencies",
  "duckdb_keywords", "duckdb_optimizers", "duckdb_schemas", "duckdb_sequences",
  "duckdb_types", "duckdb_coordinate_systems",
  "pragma_collations", "pragma_database_size", "pragma_platform", "pragma_user_agent", "pragma_version",
  "pg_timezone_names", "icu_calendar_names", "test_all_types", "test_vector_types",
]);
export const NAMED_TABLE_FUNCTIONS = new Set(["query_table", "pragma_show", "pragma_table_info", "pragma_storage_info", "duckdb_table_sample", "histogram", "histogram_values"]);
const FORBIDDEN = new Set([
  "sql_auto_complete", "pg_get_viewdef", "current_query", "getenv", "getvariable",
  "duckdb_external_file_cache", "duckdb_temporary_files", "duckdb_logs", "duckdb_logs_parsed", "duckdb_log_contexts",
  "duckdb_secrets", "duckdb_secret_types", "which_secret", "duckdb_variables", "duckdb_prepared_statements",
  "pg_prepared_statements", "pg_proc", "duckdb_profiling_settings",
  "glob", "sniff_csv", "shapefile_meta",
]);
const SAFE_SETTINGS = new Set([
  "memory_limit", "max_memory", "threads", "worker_threads", "timezone", "calendar", "default_order", "default_null_order",
  "enable_external_access", "autoload_known_extensions", "autoinstall_known_extensions", "lock_configuration",
]);
function forbiddenFunction(name: string): boolean {
  return FORBIDDEN.has(name) || /^(read_|st_read|parquet_)/.test(name);
}
function catalogKey(name: string, schema = ""): string {
  return schema === "information_schema" ? `${schema}.${name}` : name;
}
async function ownRelation(conn: DuckDBConnection, name: string, schema: string, catalog: string): Promise<boolean> {
  if (!["", "main", "memory", "temp"].includes(schema) || !["", "memory", "temp"].includes(catalog.toLowerCase())) return false;
  const rows = await conn.runAndReadAll("SELECT view_name FROM duckdb_views() WHERE database_name = 'temp' AND schema_name = 'main' AND NOT internal AND lower(view_name) = ?", [name]);
  return rows.getRowObjects().length > 0;
}
async function tableTarget(conn: DuckDBConnection, target: string, ctes: ReadonlySet<string>, catalogues: Set<string>): Promise<void> {
  const parts = qualifiedNameParts(target);
  if (!parts || parts.length > 3) refuse();
  const name = parts.at(-1)!.toLowerCase(), schema = parts.length > 1 ? parts.at(-2)!.toLowerCase() : "";
  const catalog = parts.length > 2 ? parts[0].toLowerCase() : "";
  // A dynamic string such as main.parquet could be either a qualified dataset
  // or file shorthand. Resolve only catalogue identity, never the file target.
  if (parts.length > 1 && /\.(csv|tsv|txt|tab|parquet|json|jsonl|ndjson|geojson|duckdb|db|sqlite|shp|gpkg|fgb|gz|zst|zip)$/i.test(target) && !await ownRelation(conn, name, schema, catalog)) refuse();
  await baseTarget(conn, name, schema, catalog, ctes, catalogues);
}
async function baseTarget(conn: DuckDBConnection, name: string, schema: string, catalog: string, ctes: ReadonlySet<string>, catalogues: Set<string>): Promise<void> {
  if (!schema && !catalog && ctes.has(name)) return;
  // Registered dataset names cannot contain these characters. A quoted CTE can.
  if ([name, schema, catalog].some(part => /[.\\/:*?\[\]]/.test(part))) refuse();
  const key = catalogKey(name, schema);
  if ((FORBIDDEN.has(key) || CATALOG_COLUMNS[key]) && !await ownRelation(conn, name, schema, catalog)) {
    if (FORBIDDEN.has(key)) refuse();
    catalogues.add(key);
  }
}

/** Validate parsed syntax before folding any expression. Dynamic SQL is then
 * recursively compiled and frozen as a literal, so execution cannot choose a
 * different target after admission. No user file target reaches a binder. */
export async function enforceFilePolicy(
  conn: DuckDBConnection,
  tree: SqlNode,
  nestedSql: (sql: string) => Promise<string>,
): Promise<boolean> {
  const sources = new Map<SqlNode, Set<string>>();
  let changed = false;
  async function walk(value: unknown, dynamic: boolean, ctes = new Set<string>()): Promise<void> {
    if (Array.isArray(value)) { for (const child of value) await walk(child, dynamic, ctes); return; }
    if (!isSqlNode(value)) return;
    let inner = ctes;
    const entries = isSqlNode(value.cte_map) ? value.cte_map.map : null;
    if (Array.isArray(entries)) {
      inner = new Set(ctes);
      for (const entry of entries) {
        if (!isSqlNode(entry)) continue;
        const name = String(entry.key).toLowerCase();
        const definition = isSqlNode(entry.value) && isSqlNode(entry.value.query) ? entry.value.query.node : null;
        if (isSqlNode(definition) && definition.type === "RECURSIVE_CTE_NODE") inner.add(name);
        await walk(entry.value, dynamic, inner); inner.add(name);
      }
    }
    const catalogues = sources.get(value) ?? new Set<string>();
    if (value.type === "BASE_TABLE") await baseTarget(conn, String(value.table_name).toLowerCase(), String(value.schema_name ?? "").toLowerCase(), String(value.catalog_name ?? ""), inner, catalogues);
    if (typeof value.function_name === "string") {
      const name = value.function_name.toLowerCase();
      if (forbiddenFunction(name)) refuse();
    }
    if (value.type === "TABLE_FUNCTION" && isSqlNode(value.function)) {
      const name = String(value.function.function_name).toLowerCase();
      if (CATALOG_COLUMNS[name]) catalogues.add(name);
      else if (!SAFE_TABLE_FUNCTIONS.has(name) && !NAMED_TABLE_FUNCTIONS.has(name) && name !== "query" && name !== "json_execute_serialized_sql") refuse();
    }
    if (catalogues.size) sources.set(value, catalogues);
    // Validate children first, including scalar calls inside computed targets.
    for (const [key, child] of Object.entries(value)) if (key !== "cte_map") await walk(child, dynamic, inner);
    if (!dynamic) return;
    if (typeof value.function_name === "string" && value.function_name.toLowerCase() === "current_setting") {
      const args = value.children as unknown[];
      const setting = await constantArgument(conn, args[0]);
      if (typeof setting !== "string" || !SAFE_SETTINGS.has(setting.toLowerCase())) refuse();
      args[0] = await constantExpression(conn, setting); changed = true;
    }
    if (value.type !== "TABLE_FUNCTION" || !isSqlNode(value.function)) return;
    const fn = value.function, name = String(fn.function_name).toLowerCase(), args = fn.children as unknown[];
    if ((NAMED_TABLE_FUNCTIONS.has(name) || name === "query" || name === "json_execute_serialized_sql") && args.length) {
      const resolved = await constantArgument(conn, args[0]);
      if (name === "json_execute_serialized_sql" && typeof resolved === "string") {
        // Deserialize as data, then admit the carried SQL under the same policy.
        const serialized = parseSqlJson(resolved);
        await enforceFilePolicy(conn, serialized, nestedSql);
        const nested = await sqlText(conn, serialized);
        fn.function_name = "query"; fn.schema = ""; fn.catalog = "";
        args[0] = await constantExpression(conn, await nestedSql(nested)); changed = true;
      } else if (name === "query" && typeof resolved === "string") {
        args[0] = await constantExpression(conn, await nestedSql(resolved)); changed = true;
      } else if (NAMED_TABLE_FUNCTIONS.has(name) && (typeof resolved === "string" || (Array.isArray(resolved) && resolved.every(v => typeof v === "string")))) {
        for (const target of typeof resolved === "string" ? [resolved] : resolved) await tableTarget(conn, target, inner, catalogues);
        if (catalogues.size) sources.set(value, catalogues);
        args[0] = await constantExpression(conn, resolved); changed = true;
      } else refuse();
    }
  }
  await walk(tree, false);
  changed = await guardProjectionValues(conn, tree) || changed;
  inspectCatalogues(tree, sources, refuse);
  await walk(tree, true);
  inspectCatalogues(tree, sources, refuse);
  return changed;
}
