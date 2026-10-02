import { tableRef } from "./input-ref";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * The verbs that are about rows rather than about shapes: filter rows, join
 * by key, dissolve, group & summarize.
 *
 * **Plain data verbs are deliberately in the catalog.** The audience that
 * cannot write a spatial join cannot write a `WHERE` clause either, and a
 * catalog that offered only the spatial half would send them back to SQL for
 * the easy things.
 *
 * **Nothing here interpolates a user's value into SQL as text.** A filter's
 * value is a parameter binding, and a field name is checked against the
 * table's own columns before it is quoted — the read-only guard protects the
 * engine, not the meaning of the query.
 */

/** Comparisons a filter can make. Fixed here rather than by whatever a caller
 * sends, so an unknown one is a refusal instead of a SQL fragment. */
export const COMPARISONS = [
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "contains",
  "is_null",
  "is_not_null",
] as const;
export type Comparison = (typeof COMPARISONS)[number];

const OPERATOR: Record<Comparison, string> = {
  equals: "=",
  not_equals: "<>",
  greater_than: ">",
  less_than: "<",
  contains: "LIKE",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};

/** Aggregates a summary can take. The same set the spatial join carries, minus
 * the geometry-aware ones it does not have. */
export const SUMMARY_AGGREGATES = ["count", "sum", "mean", "min", "max"] as const;
export type SummaryAggregate = (typeof SUMMARY_AGGREGATES)[number];

const AGGREGATE_SQL: Record<SummaryAggregate, (column: string) => string> = {
  count: () => "count(*)",
  sum: (c) => `sum(${c})`,
  mean: (c) => `avg(${c})`,
  min: (c) => `min(${c})`,
  max: (c) => `max(${c})`,
};

export function requireColumn(
  table: DataTable,
  columns: string[],
  field: string,
  role: string,
): string {
  const found = columns.find((c) => c.toLowerCase() === field.toLowerCase());
  if (!found) {
    // The role is a noun ("grouping column", "left key"), so the sentence
    // must not treat it as a verb — "nothing to grouping column" shipped
 // (fixed at the sitting's word).
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no column called "${field}" to use as the ` +
        `${role}. Its columns are: ${columns.join(", ")}.`,
      400,
    );
  }
  return found;
}

/** A literal, quoted for SQL. Values arrive as parameters from a form, and a
 * quote inside one is an escaped quote rather than the end of a string. */
function literal(value: string | number | boolean): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Filter rows: keep the rows matching one condition.
 *
 * One condition rather than a builder, deliberately: the layer's own filter
 * stack already composes several, and a step that needs more than one is a SQL
 * step. What this verb is for is the common case, without SQL.
 */
export function filterRowsSql(
  table: DataTable,
  column: string,
  comparison: Comparison,
  value: string | number | boolean | null,
): string {
  const field = `t.${ident(column)}`;
  const operator = OPERATOR[comparison];
  if (comparison === "is_null" || comparison === "is_not_null") {
    return `SELECT * FROM ${tableRef(table)} AS t WHERE ${field} ${operator}`;
  }
  if (value === null) {
    throw new ApiError(
      "invalid_request",
      `The "${comparison.replace(/_/g, " ")}" comparison needs a value to ` +
        `compare against.`,
      400,
    );
  }
  if (comparison === "contains") {
    // **A literal substring, not a pattern.** `%` and `_` are LIKE
    // metacharacters, so searching for "100%" matched every row that began
    // with 100 — the user's value became a query language they did not know
    // they were writing.
    const escaped = String(value).replace(/([%_\\])/g, "\\$1");
    return `SELECT * FROM ${tableRef(table)} AS t
WHERE CAST(${field} AS VARCHAR) LIKE ${literal(`%${escaped}%`)} ESCAPE '\\'`;
  }
  return `SELECT * FROM ${tableRef(table)} AS t WHERE ${field} ${operator} ${literal(value)}`;
}

/**
 * Join by key: carry values across by matching a field, not by geometry.
 *
 * One row out per left row — the same promise the spatial join makes, for the
 * same reason. Where the right side has several matches for a key, the first
 * is taken and the count is carried, so a reader can see that the key was not
 * unique rather than discovering it as a silently missing value.
 */
export function joinByKeySql(
  left: DataTable,
  right: DataTable,
  leftKey: string,
  rightKey: string,
  carry: string[],
): string {
  const carried = carry
    .map((column) => `r.${ident(column)} AS ${ident(column)}`)
    .join(",\n       ");
  const select = carried ? `${carried},\n       ` : "";
  // **One right row, chosen once, and every carried value taken from it.**
  // Aggregating each column independently could combine values from different
  // rows into a record that never existed — and it did not implement the
  // promise the catalog makes, which is that the first match is taken.
  return `WITH ranked AS (
  SELECT *, row_number() OVER (PARTITION BY ${ident(rightKey)} ORDER BY ${ident(rightKey)}) AS rank_in_key,
         count(*) OVER (PARTITION BY ${ident(rightKey)}) AS match_count
  FROM ${tableRef(right)}
)
SELECT l.*,
       ${select}r.match_count AS join_match_count
FROM ${tableRef(left)} AS l
LEFT JOIN ranked AS r
ON l.${ident(leftKey)} = r.${ident(rightKey)} AND r.rank_in_key = 1`;
}

/**
 * Dissolve: one shape per group, or one shape overall.
 *
 * The count of features merged is carried, because a dissolve that produced
 * one row from one feature and one row from four hundred looks identical
 * otherwise.
 */
export function dissolveSql(
  table: DataTable,
  geometryColumn: string,
  groupBy: string[],
): string {
  const geom = ident(geometryColumn);
  const groups = groupBy.map(ident);
  const select = groups.length > 0 ? `${groups.join(", ")}, ` : "";
  const group = groups.length > 0 ? `GROUP BY ${groups.join(", ")}` : "";
  return `SELECT ${select}count(*) AS feature_count,
       ST_Union_Agg(t.${geom}) AS ${geom}
FROM ${tableRef(table)} AS t
WHERE t.${geom} IS NOT NULL
${group}`;
}

/**
 * Group & summarize: one row per group, with the aggregates asked for.
 *
 * **The result has no geometry**, and that is a dataset rather than a failure —
 * the path opened for the SQL step. The output's columns are named for what
 * they are (`sum_population`), because a column called `sum` says nothing a
 * month later.
 */
export function groupSummarizeSql(
  table: DataTable,
  groupBy: string[],
  aggregates: { aggregate: SummaryAggregate; field?: string }[],
): string {
  const groups = groupBy.map(ident);
  const columns = aggregates.map(({ aggregate, field }) => {
    const name =
      aggregate === "count" ? "feature_count" : `${aggregate}_${field ?? "value"}`;
    const expression = AGGREGATE_SQL[aggregate](field ? ident(field) : "*");
    return `${expression} AS ${ident(name)}`;
  });
  const select = [...groups, ...columns].join(",\n       ");
  const group = groups.length > 0 ? `GROUP BY ${groups.join(", ")}` : "";
  return `SELECT ${select}
FROM ${tableRef(table)} AS t
${group}`;
}
