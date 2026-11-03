/**
 * The layers and fields whose statistics answers were recorded before the
 * classification distribution existed, so a request without it can be
 * held to the bytes it answered then. Whole counts, a decimal column, a
 * label, a time, the cells of a count and of an average, and a filter that
 * the plain request ignores.
 */
export const FIELD_STATS_SQL = `SELECT (i % 7 + i // 50)::INTEGER AS n, i * 0.37 AS x, 'k' || (i % 3) AS label,
  TIMESTAMP '2025-01-01 00:00:00' + to_hours(i) AS at,
  ST_Point(13 + (i % 20) * 0.02, 52 + (i // 20) * 0.02) AS geometry
  FROM range(0, 200) AS t(i)`;

const filtered = [{ field: "n", kind: "range" as const, min: 2, max: null }];

export const FIELD_STATS_CASES: {
  name: string;
  field: string;
  viz?: Record<string, unknown>;
  filters?: typeof filtered;
}[] = [
  { name: "whole counts", field: "n" },
  { name: "decimal column", field: "x" },
  { name: "label", field: "label" },
  { name: "time", field: "at" },
  { name: "filtered whole counts", field: "n", filters: filtered },
  { name: "count cells' value", field: "value", viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" } } },
  { name: "average cells' value", field: "value", viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "avg", attribute: "n" } } },
  { name: "average cells' count", field: "count", viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "avg", attribute: "n" } } },
  { name: "filtered grid count", field: "value", viz: { type: "grid", cellKm: 5, aggregate: { fn: "count" } }, filters: filtered },
];
