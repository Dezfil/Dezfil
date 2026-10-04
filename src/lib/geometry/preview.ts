import { readBudgetedRows } from "@/lib/query/budget-reader";
import { jsonBytes, type ResultBudget } from "@/lib/query/result-budget";
import type { DuckDBConnection } from "@duckdb/node-api";
import { INSPECT_PREVIEW_ROWS } from "@/lib/table-preview-limit";
import { collapseGeometryTypes } from "@/lib/ingest/ingest";
import { ident } from "@/lib/ingest/sql";
import type { EvaluatedGeometry } from "./evaluate";
import type { GeometryExtent, GeometryPreview } from "./types";

export async function measureGeometry(conn: DuckDBConnection, evaluated: EvaluatedGeometry) {
  const { from, output, present } = evaluated;
  const g = ident(output);
  const stats = (await conn.runAndReadAll(`SELECT count(*) n,
    list(DISTINCT ST_GeometryType(${g})) FILTER (WHERE ${g} IS NOT NULL) geometry_types,
    count(*) FILTER (WHERE ${ident(present)} AND ${g} IS NULL) unreadable,
    min(ST_XMin(${g})) FILTER (WHERE NOT ST_IsEmpty(${g})) west,
    min(ST_YMin(${g})) FILTER (WHERE NOT ST_IsEmpty(${g})) south,
    max(ST_XMax(${g})) FILTER (WHERE NOT ST_IsEmpty(${g})) east,
    max(ST_YMax(${g})) FILTER (WHERE NOT ST_IsEmpty(${g})) north FROM ${from}`)).getRowObjects()[0];
  const types = (stats.geometry_types as { items: unknown[] } | null)?.items.map(String) ?? [];
  return { rowCount: Number(stats.n), unreadableCount: Number(stats.unreadable), geometryType: collapseGeometryTypes(types),
    extent: stats.west === null ? null : [stats.west, stats.south, stats.east, stats.north].map(Number) as GeometryExtent };
}
export async function sampleGeometry(conn: DuckDBConnection, e: EvaluatedGeometry, columns: { name: string; type: string }[], budget: ResultBudget): Promise<GeometryPreview["sample"]> {
  // Grid cells show bounded excerpts, never megabytes of source WKT per row.
  const originals = columns.map(c => {
    const value = c.type.startsWith("GEOMETRY") ? `ST_AsText(${ident(c.name)})` : ident(c.name);
    return c.type.startsWith("GEOMETRY") || c.type === "VARCHAR"
      ? `CASE WHEN length(${value}) > 512 THEN left(${value}, 512) || '…' ELSE ${value} END AS ${ident(c.name)}` : value;
  });
  // Preview only: a small fraction of the geometry's span keeps its outline
  // while removing detail the preview map cannot use. Bounds and row verdicts
  // above are measured on the unsimplified sample.
  const g = ident(e.output);
  const simplified = `ST_SimplifyPreserveTopology(${g}, greatest(ST_XMax(${g}) - ST_XMin(${g}), ST_YMax(${g}) - ST_YMin(${g})) / 256)`;
  const jsonName = `json_${crypto.randomUUID().replaceAll("-", "")}`;
  const statusName = `status_${crypto.randomUUID().replaceAll("-", "")}`;
  const status = `CASE WHEN NOT ${ident(e.present)} THEN 'missing' WHEN ${g} IS NOT NULL THEN 'readable'
    WHEN ${ident(e.raw)} IS NOT NULL AND ${e.issues.some(i => i.code === "projection_required")} THEN 'projection-required' ELSE 'unreadable' END`;
  const geometryColumns = new Set(columns.filter(c => c.type.startsWith("GEOMETRY")).map(c => c.name));
  geometryColumns.add(jsonName);
  const rows = await readBudgetedRows(conn, `SELECT ${originals.join(", ")}, ${status} AS ${ident(statusName)},
    ST_AsGeoJSON(coalesce(TRY(${simplified}), ${g})) AS ${ident(jsonName)} FROM ${e.from} LIMIT ${INSPECT_PREVIEW_ROWS}`,
    budget, geometryColumns, false, undefined, {
      geometryJSONColumns: new Set([jsonName]),
      // The envelope already includes both empty arrays. Each native row adds
      // one grid row and one feature, including their independent separators.
      rowBytes: index => jsonBytes({ index, values: {}, status: null }) - 4
        + jsonBytes({ type: "Feature", id: index, geometry: null, properties: {} }) - 4
        + (index ? 2 : 0) + Math.max(0, columns.length - 1),
      keyBytes: name => name === jsonName || name === statusName ? 0 : jsonBytes(name) + 1,
    });
  const sample: GeometryPreview["sample"] = { rows: [], features: { type: "FeatureCollection", features: [] } };
  rows.forEach((row, index) => {
    const geometry = row[jsonName];
    const status = row[statusName] as GeometryPreview["sample"]["rows"][number]["status"];
    sample.rows.push({ index, values: Object.fromEntries(columns.map(c => [c.name, row[c.name]])), status });
    sample.features.features.push({ type: "Feature", id: index, geometry, properties: {} });
  });
  return sample;
}
