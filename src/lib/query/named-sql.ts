import { NAMED_TABLE_FUNCTIONS } from "./file-policy";
import { parseSql as parse, sqlText as text, isSqlNode as record, constantArgument as argument, constantExpression as expression } from "./sql-tree";
import { localName, qualifiedNameParts } from "./qualified-name";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { isOutOfMemory } from "./bounded";
import { sqlError } from "./engine-message";
import { readOnlySql } from "./guard";

/** Compile catalog-qualified saved SQL against this connection's temporary
 * views. Unqualified names and CTEs retain DuckDB's own resolution. Dynamic
 * table names and nested SQL are resolved by the same engine before rewriting;
 * stored SQL and provenance text are never rewritten. */
async function compileNamedSql(conn: DuckDBConnection, sql: string): Promise<string> {
  const admitted = await readOnlySql(conn, sql);
  const tree = await parse(conn, admitted);
  let changed = false;
  async function walk(value: unknown, tables = new Set<string>(), aliases = new Set<string>()): Promise<void> {
    if (Array.isArray(value)) { for (const child of value) await walk(child, tables, aliases); return; }
    if (!record(value)) return;
    if (value.type === "SELECT_NODE") {
      // Resolve FROM before expressions, including computed query_table names.
      const localTables = new Set(tables), localAliases = new Set(aliases);
      await walk(value.from_table, localTables, localAliases);
      for (const [key, child] of Object.entries(value)) {
        if (key === "cte_map") await walk(child);
        else if (key !== "from_table") await walk(child, localTables, localAliases);
      }
      return;
    }
    if (["BASE_TABLE", "SUBQUERY", "TABLE_FUNCTION", "JOIN", "EXPRESSION_LIST"].includes(String(value.type)) && typeof value.alias === "string" && value.alias) aliases.add(value.alias.toLowerCase());
    if (value.type === "BASE_TABLE") {
      tables.add(String(value.table_name).toLowerCase());
      if (!value.alias) aliases.add(String(value.table_name).toLowerCase());
      const catalog = String(value.catalog_name ?? "").toLowerCase();
      const schema = String(value.schema_name ?? "").toLowerCase();
      if ((catalog === "memory" && (!schema || schema === "main")) || (!catalog && schema === "memory")) {
        value.catalog_name = "temp"; value.schema_name = "main"; changed = true;
      }
    }
    if (value.class === "COLUMN_REF" && Array.isArray(value.column_names)) {
      const names = value.column_names as string[];
      const full = names.length >= 4 && names[1]?.toLowerCase() === "main" && tables.has(names[2]?.toLowerCase());
      const short = names.length >= 3 && tables.has(names[1]?.toLowerCase());
      if (names[0]?.toLowerCase() === "memory" && (full || short) && !aliases.has("memory")) {
        value.column_names = full ? ["temp", ...names.slice(1)] : ["temp", "main", ...names.slice(1)];
        changed = true;
      }
    }
    if (value.type === "TABLE_FUNCTION" && record(value.function)) {
      const fn = value.function, kind = String(fn.function_name).toLowerCase();
      if ((NAMED_TABLE_FUNCTIONS.has(kind) || kind === "query") && Array.isArray(fn.children) && fn.children.length) {
        const resolved = await argument(conn, fn.children[0]);
        if (kind === "query" && typeof resolved === "string") {
          fn.children[0] = await expression(conn, await namedSql(conn, resolved)); changed = true;
        } else if (NAMED_TABLE_FUNCTIONS.has(kind) && (typeof resolved === "string" || (Array.isArray(resolved) && resolved.every(v => typeof v === "string")))) {
          const targets = typeof resolved === "string" ? [resolved] : resolved;
          for (const target of targets) {
            const bare = qualifiedNameParts(target)?.at(-1);
            if (bare) tables.add(bare.toLowerCase());
          }
          fn.children[0] = await expression(conn, typeof resolved === "string" ? localName(resolved) : resolved.map(localName)); changed = true;
        }
      }
    }
    for (const child of Object.values(value)) await walk(child, tables, aliases);
  }
  await walk(tree);
  return changed ? await text(conn, tree) : admitted;
}

export async function namedSql(conn: DuckDBConnection, sql: string): Promise<string> {
  try { return await compileNamedSql(conn, sql); }
  catch (error) {
    if (error instanceof ApiError || isOutOfMemory(error)) throw error;
    throw sqlError(error);
  }
}
