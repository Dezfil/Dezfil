import { isSqlNode, type SqlNode } from "./sql-tree";

// Definition-bearing catalogues still support explicit name/schema inspection.
// Stars, whole rows, positional references and definition/path columns do not.
export const CATALOG_COLUMNS: Record<string, string[]> = {
  duckdb_views: ["database_name", "database_oid", "schema_name", "schema_oid", "view_name", "view_oid", "comment", "tags", "internal", "temporary", "column_count", "is_bound"],
  duckdb_tables: ["database_name", "database_oid", "schema_name", "schema_oid", "table_name", "table_oid", "comment", "tags", "internal", "temporary", "has_primary_key", "estimated_size", "column_count", "index_count", "check_constraint_count"],
  duckdb_indexes: ["database_name", "database_oid", "schema_name", "schema_oid", "index_name", "index_oid", "table_name", "table_oid", "comment", "tags", "is_unique", "is_primary"],
  duckdb_databases: ["database_name", "database_oid", "comment", "tags", "internal", "type", "readonly", "encrypted"],
  duckdb_functions: ["database_name", "database_oid", "schema_name", "function_name", "alias_of", "function_type", "description", "comment", "tags", "return_type", "parameters", "parameter_types", "varargs", "has_side_effects", "internal", "function_oid", "examples", "stability", "categories"],
  duckdb_settings: ["name", "description", "input_type", "scope", "aliases"],
  duckdb_extensions: ["extension_name", "loaded", "installed", "description", "aliases", "extension_version", "install_mode"],
  sqlite_master: ["type", "name", "tbl_name", "rootpage"],
  sqlite_schema: ["type", "name", "tbl_name", "rootpage"],
  sqlite_temp_master: ["type", "name", "tbl_name", "rootpage"],
  sqlite_temp_schema: ["type", "name", "tbl_name", "rootpage"],
  "information_schema.views": ["table_catalog", "table_schema", "table_name", "check_option", "is_updatable", "is_insertable_into", "is_trigger_updatable", "is_trigger_deletable", "is_trigger_insertable_into"],
  pg_views: ["schemaname", "viewname", "viewowner"],
  pg_indexes: ["schemaname", "tablename", "indexname", "tablespace"],
  pg_settings: ["name", "short_desc", "vartype"],
  pragma_database_list: ["seq", "name"],
};

/** The catalogue functions that list relations or their columns: what a
 * published link's restricted mount would answer differently from its
 * owner's whole reach. The engine's own relations read as tables
 * (information_schema, pg_catalog, sqlite_master) are read the same way. */
export const CATALOGUE_READERS = new Set([
  "duckdb_views", "duckdb_tables", "duckdb_columns", "duckdb_constraints", "duckdb_dependencies", "duckdb_indexes",
]);

/** Track catalogue relations through each SELECT scope. A safe projection is a
 * safe derived relation; catalogue aliases never make definitions into data. */
export function inspectCatalogues(tree: SqlNode, sources: Map<SqlNode, Set<string>>, refuse: () => never): void {
  const inspected = new Set<SqlNode>();
  type Columns = Set<string> | null;
  type Scope = Map<string, Columns>;
  function inspect(value: unknown, scope: Scope, starRestricted = false): void {
    if (Array.isArray(value)) { for (const child of value) inspect(child, scope, starRestricted); return; }
    if (!isSqlNode(value)) return;
    if (value.type === "SELECT_NODE") {
      const local = new Map(scope);
      let restricted = false;
      function relation(node: unknown): void {
        if (!isSqlNode(node)) return;
        const catalogues = sources.get(node);
        if (catalogues) inspected.add(node);
        const columns = catalogues ? new Set([...catalogues].flatMap(name => CATALOG_COLUMNS[name])) : null;
        const name = String(node.alias || node.table_name || (isSqlNode(node.function) ? node.function.function_name : "")).toLowerCase();
        if (columns) {
          restricted = true;
          // Column-list aliases can turn a definition column into an apparently
          // safe name. Refuse this path before any catalogue rows are read.
          if (Array.isArray(node.column_name_alias) && node.column_name_alias.length) refuse();
          if (!node.alias) for (const catalogue of catalogues!) local.set(catalogue.split(".").at(-1)!, columns);
        }
        if (name) local.set(name, columns);
        if (node.type === "SUBQUERY") return;
        for (const key of ["left", "right", "child", "source"]) relation(node[key]);
        if (node.type !== "BASE_TABLE" && node.type !== "TABLE_FUNCTION" && node.alias && restricted) refuse();
      }
      relation(value.from_table);
      for (const [key, child] of Object.entries(value)) {
        // CTE definitions are independent relations, not correlated FROM rows.
        inspect(child, key === "cte_map" ? new Map() : local, key === "cte_map" ? false : restricted);
      }
      return;
    }
    const catalogues = [...scope.values()].filter((columns): columns is Set<string> => columns !== null);
    if (catalogues.length) {
      if (value.class === "STAR" || value.type === "STAR") {
        const relation = String(value.relation_name ?? "").toLowerCase();
        if (relation ? !scope.has(relation) || scope.get(relation) !== null : starRestricted) refuse();
      }
      if (value.class === "POSITIONAL_REFERENCE" && starRestricted) refuse();
      if (value.class === "COLUMN_REF" && Array.isArray(value.column_names)) {
        const names = value.column_names.map(name => String(name).toLowerCase());
        const column = names.at(-1)!;
        const qualifier = names.slice(0, -1).find(name => scope.has(name));
        if (qualifier !== undefined) {
          const columns = scope.get(qualifier);
          if (columns && !columns.has(names[names.indexOf(qualifier) + 1])) refuse();
        } else {
          // A bare relation is a whole-row reference. Unqualified columns must
          // be among the catalogue's explicit safe projections.
          if (scope.get(column)) refuse();
          if (!catalogues.some(columns => columns.has(column))) refuse();
        }
      }
    }
    for (const child of Object.values(value)) inspect(child, scope, starRestricted);
  }
  inspect(tree, new Map());
  // New or unusual relation shapes cannot bypass catalogue projection checks.
  for (const source of sources.keys()) if (!inspected.has(source)) refuse();
}
