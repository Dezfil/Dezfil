import { randomUUID } from "node:crypto";
import { NAMED_TABLE_FUNCTIONS } from "./file-policy";
import { parseSql as parse, sqlText as text, isSqlNode as record, constantArgument as argument, constantExpression as expression, selectNode, type SqlNode } from "./sql-tree";
import { localName, qualifiedNameParts } from "./qualified-name";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { isOutOfMemory } from "./bounded";
import { sqlError, UNKNOWN_TABLE_MESSAGE } from "./engine-message";
import { readOnlySql } from "./guard";
import { classifyReference, writtenReference } from "./reference-forms";
import { unavailableDataset } from "./bindings";
import { isCteReference } from "./references";
import { mountPlanOf, type MountPlan, type QualifiedBinding } from "./mount-plan";

/**
 * Compile admitted SQL against this connection's temporary views.
 *
 * Unqualified names and CTEs keep DuckDB's own resolution. The engine's
 * `memory` catalogue forms are mapped onto the local `temp` catalogue. A
 * two-part name whose first part is a person's SQL name, `ada.roads`, is
 * mapped onto the view this evaluation mounted for that dataset, wherever it
 * appears: a table reference (keeping `roads` as its alias, as a schema-
 * qualified table would), a qualified column (`ada.roads.x`), a qualified
 * star exclusion, a dynamic table-function argument and nested SQL. Aliases,
 * common table expressions and struct paths keep their meaning: a first part
 * that is an alias in scope is never a SQL name. A home dataset that a
 * workflow's declared output shadows is reached through a private relation
 * this statement alone defines, never a catalogue entry. Dynamic table names
 * and nested SQL are resolved by the same engine before rewriting; stored SQL
 * and provenance text are never rewritten.
 */

/** The table functions a statement-local relation can stand behind. */
const LOCAL_RELATION_FUNCTIONS = new Set(["query_table", "histogram", "histogram_values"]);

/** The private relations one compilation defines for synthetic bindings. */
type Synthetics = Map<string, { name: string; from: string }>;

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

function syntheticName(synthetics: Synthetics, plan: MountPlan, binding: { synthetic: { id: string } }): string {
  const existing = synthetics.get(binding.synthetic.id);
  if (existing) return existing.name;
  const name = `__dezfil_home_${randomUUID().replaceAll("-", "")}`;
  synthetics.set(binding.synthetic.id, { name, from: plan.synthetic.get(binding.synthetic.id)! });
  return name;
}

/** The failure of a reference that binds nothing. A resource evaluation (a
 * layer, tile, render, widget, export, search or workflow step) names the
 * reference as written and says it is not available to the caller; the
 * console keeps the engine's generic unknown-table refusal. Neither says
 * whether the dataset exists or whose it would be. */
function unbound(plan: MountPlan, parts: readonly string[]): ApiError {
  return plan.purpose === "resource" ? unavailableDataset(writtenReference(parts)) : new ApiError("sql_error", UNKNOWN_TABLE_MESSAGE, 400);
}

/** Whether a name binds to a relation this connection has: the engine's own
 * catalogues and an evaluation's private staging inputs, never a dataset
 * (every dataset in reach is in the plan). */
async function bindsAsRelation(conn: DuckDBConnection, parts: readonly string[]): Promise<boolean> {
  try {
    await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${parts.map(quoted).join(".")}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse, in a resource evaluation, a reference the namespace cannot bind:
 * a qualified name outside reach, a declared output this runner has not
 * produced, and, when the caller is not the SQL home, a plain name the home's
 * reachable datasets do not hold. For the home itself an unknown plain name
 * keeps the engine's own refusal, as it always has. The console is left to
 * the engine: the same generic refusal for a hidden and a missing name.
 */
async function refuseUnbound(conn: DuckDBConnection, plan: MountPlan | undefined, parts: readonly string[]): Promise<void> {
  if (!plan || plan.purpose !== "resource") return;
  const classified = classifyReference(parts);
  if (classified.form === "engine") return;
  if (classified.form === "qualified") {
    if (!plan.qualified.has(`${classified.qualifier}.${classified.name}`)) throw unbound(plan, parts);
    return;
  }
  const view = plan.plain.get(classified.name);
  if (view === null) throw unbound(plan, parts);
  if (view !== undefined || plan.callerIsHome) return;
  if (!await bindsAsRelation(conn, parts)) throw unbound(plan, parts);
}

/** How a qualified name is reached here, when it names a SQL name's dataset. */
function qualifiedBinding(plan: MountPlan | undefined, parts: readonly string[]): { key: string; binding: QualifiedBinding | undefined } | null {
  if (!plan) return null;
  const classified = classifyReference(parts);
  if (classified.form !== "qualified") return null;
  const key = `${classified.qualifier}.${classified.name}`;
  return { key, binding: plan.qualified.get(key) };
}

async function compileNamedSql(conn: DuckDBConnection, sql: string, synthetics: Synthetics): Promise<string> {
  const plan = mountPlanOf(conn);
  const admitted = await readOnlySql(conn, sql);
  const tree = await parse(conn, admitted);
  let changed = false;

  /** Scope: tables and aliases in scope (lower-cased), the CTE names in
   * scope, and the qualified tables rewritten here, by `<sql name>.<name>`,
   * with the alias their columns now go by. */
  interface Scope { tables: Set<string>; aliases: Set<string>; ctes: Set<string>; qualified: Map<string, string> }
  const fresh = (): Scope => ({ tables: new Set(), aliases: new Set(), ctes: new Set(), qualified: new Map() });
  const copy = (scope: Scope): Scope => ({ tables: new Set(scope.tables), aliases: new Set(scope.aliases), ctes: new Set(scope.ctes), qualified: new Map(scope.qualified) });

  async function walk(value: unknown, scope: Scope): Promise<void> {
    if (Array.isArray(value)) { for (const child of value) await walk(child, scope); return; }
    if (!record(value)) return;

    // A node with CTEs puts their names in scope for its body; each
    // definition sees the names defined before it (and itself, when it is
    // recursive), as the engine binds them.
    const entries = record(value.cte_map) ? value.cte_map.map : null;
    let inner = scope;
    if (Array.isArray(entries) && entries.length) {
      const growing = new Set(scope.ctes);
      for (const entry of entries) {
        if (!record(entry)) continue;
        const name = String(entry.key).toLowerCase();
        const definition = record(entry.value) && record(entry.value.query) ? entry.value.query.node : null;
        const recursive = record(definition) && definition.type === "RECURSIVE_CTE_NODE";
        await walk(entry.value, { ...fresh(), ctes: recursive ? new Set([...growing, name]) : new Set(growing) });
        growing.add(name);
      }
      inner = { ...scope, ctes: growing };
    }

    if (value.type === "SELECT_NODE") {
      // Resolve FROM before expressions, including computed query_table names.
      const local = copy(inner);
      await walk(value.from_table, local);
      for (const [key, child] of Object.entries(value)) {
        if (key !== "from_table" && key !== "cte_map") await walk(child, local);
      }
      return;
    }
    if (["BASE_TABLE", "SUBQUERY", "TABLE_FUNCTION", "JOIN", "EXPRESSION_LIST"].includes(String(value.type)) && typeof value.alias === "string" && value.alias) inner.aliases.add(value.alias.toLowerCase());
    if (value.type === "BASE_TABLE") {
      inner.tables.add(String(value.table_name).toLowerCase());
      if (!value.alias) inner.aliases.add(String(value.table_name).toLowerCase());
      const catalog = String(value.catalog_name ?? ""), schema = String(value.schema_name ?? "");
      const lowerCatalog = catalog.toLowerCase(), lowerSchema = schema.toLowerCase();
      const parts = [catalog, schema, String(value.table_name)].filter(Boolean);
      const cte = isCteReference(inner.ctes, catalog, schema, String(value.table_name));
      if (!cte) await refuseUnbound(conn, plan, parts);
      if ((lowerCatalog === "memory" && (!lowerSchema || lowerSchema === "main")) || (!lowerCatalog && lowerSchema === "memory")) {
        value.catalog_name = "temp"; value.schema_name = "main"; changed = true;
      } else if (!cte) {
        const found = qualifiedBinding(plan, parts);
        if (found?.binding) {
          const written = String(value.table_name);
          const target = "view" in found.binding ? found.binding.view : syntheticName(synthetics, plan!, found.binding);
          value.catalog_name = ""; value.schema_name = ""; value.table_name = target;
          // A schema-qualified table goes by its own name; so does its view.
          if (!value.alias && target.toLowerCase() !== written.toLowerCase()) value.alias = written;
          const alias = String(value.alias || target).toLowerCase();
          inner.aliases.add(alias);
          inner.qualified.set(found.key, alias);
          changed = true;
        }
      }
    }
    if (value.class === "COLUMN_REF" && Array.isArray(value.column_names)) {
      const names = value.column_names as string[];
      const full = names.length >= 4 && names[1]?.toLowerCase() === "main" && inner.tables.has(names[2]?.toLowerCase());
      const short = names.length >= 3 && inner.tables.has(names[1]?.toLowerCase());
      if (names[0]?.toLowerCase() === "memory" && (full || short) && !inner.aliases.has("memory")) {
        value.column_names = full ? ["temp", ...names.slice(1)] : ["temp", "main", ...names.slice(1)];
        changed = true;
      } else if (names.length >= 3 && !inner.aliases.has(names[0].toLowerCase())) {
        const alias = inner.qualified.get(`${names[0]}.${names[1]}`.toLowerCase());
        if (alias !== undefined) { value.column_names = [alias, ...names.slice(2)]; changed = true; }
      }
    }
    if ((value.class === "STAR" || value.type === "STAR") && Array.isArray(value.qualified_exclude_list)) {
      for (const excluded of value.qualified_exclude_list) {
        if (!record(excluded) || excluded.catalog || !excluded.schema) continue;
        const alias = inner.qualified.get(`${excluded.schema}.${excluded.table}`.toLowerCase());
        if (alias !== undefined) { excluded.schema = ""; excluded.table = alias; changed = true; }
      }
    }
    if (value.type === "TABLE_FUNCTION" && record(value.function)) {
      const fn = value.function, kind = String(fn.function_name).toLowerCase();
      if ((NAMED_TABLE_FUNCTIONS.has(kind) || kind === "query") && Array.isArray(fn.children) && fn.children.length) {
        const resolved = await argument(conn, fn.children[0]);
        if (kind === "query" && typeof resolved === "string") {
          fn.children[0] = await expression(conn, await compileNested(conn, resolved, synthetics)); changed = true;
        } else if (NAMED_TABLE_FUNCTIONS.has(kind) && (typeof resolved === "string" || (Array.isArray(resolved) && resolved.every(v => typeof v === "string")))) {
          const targets = typeof resolved === "string" ? [resolved] : resolved;
          const mapped: string[] = [];
          for (const target of targets) {
            const parts = qualifiedNameParts(target);
            const bare = parts?.at(-1);
            if (bare) inner.tables.add(bare.toLowerCase());
            if (parts && !(parts.length === 1 && inner.ctes.has(parts[0].toLowerCase()))) {
              await refuseUnbound(conn, plan, parts);
              const found = qualifiedBinding(plan, parts);
              if (found?.binding) {
                if ("view" in found.binding) { mapped.push(quoted(found.binding.view)); continue; }
                // A statement-local relation stands behind the reading
                // functions; an inspection function needs a catalogue entry,
                // and a shadowed home dataset never has one.
                if (!LOCAL_RELATION_FUNCTIONS.has(kind)) throw unbound(plan!, parts);
                mapped.push(quoted(syntheticName(synthetics, plan!, found.binding)));
                continue;
              }
            }
            mapped.push(localName(target));
          }
          fn.children[0] = await expression(conn, typeof resolved === "string" ? mapped[0] : mapped); changed = true;
        }
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== "cte_map") await walk(child, inner);
  }
  await walk(tree, fresh());
  return changed ? await text(conn, tree) : admitted;
}

/** SQL carried by `query()`: compiled in the same namespace, its private
 * relations defined once, by the statement that carries it. */
async function compileNested(conn: DuckDBConnection, sql: string, synthetics: Synthetics): Promise<string> {
  return compileNamedSql(conn, sql, synthetics);
}

/** Define each private relation a statement uses at its root, where every
 * nested scope and every carried query of the statement can see it. */
async function defineSynthetics(conn: DuckDBConnection, sql: string, synthetics: Synthetics): Promise<string> {
  const definitions = [...synthetics.values()];
  const tree = await parse(conn, sql);
  const root = selectNode(tree) as SqlNode & { cte_map: { map: unknown[] } };
  const carrier = await parse(conn, `WITH ${definitions.map(({ name, from }) => `${quoted(name)} AS (SELECT * FROM ${from})`).join(", ")} SELECT 1`);
  root.cte_map.map.unshift(...(selectNode(carrier) as SqlNode & { cte_map: { map: unknown[] } }).cte_map.map);
  return text(conn, tree);
}

export async function namedSql(conn: DuckDBConnection, sql: string): Promise<string> {
  try {
    const synthetics: Synthetics = new Map();
    const compiled = await compileNamedSql(conn, sql, synthetics);
    return synthetics.size ? await defineSynthetics(conn, compiled, synthetics) : compiled;
  } catch (error) {
    if (error instanceof ApiError || isOutOfMemory(error)) throw error;
    throw sqlError(error);
  }
}
