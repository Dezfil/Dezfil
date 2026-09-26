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
export async function sampleGeometry(conn: DuckDBConnection, e: EvaluatedGeometry, columns: { name: string; type: string }[]): Promise<GeometryPreview["sample"]> {
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
  const rows = (await conn.runAndReadAll(`SELECT ${originals.join(", ")}, ${ident(e.present)}, ${ident(e.raw)} IS NOT NULL AS ${ident(e.raw)},
    ST_AsGeoJSON(coalesce(TRY(${simplified}), ${g})) AS ${ident(jsonName)} FROM ${e.from} LIMIT ${INSPECT_PREVIEW_ROWS}`)).getRowObjectsJson() as Record<string, unknown>[];
  const sample: GeometryPreview["sample"] = { rows: [], features: { type: "FeatureCollection", features: [] } };
  rows.forEach((row, index) => {
    const geometry = row[jsonName] === null ? null : JSON.parse(String(row[jsonName]));
    const status = !row[e.present] ? "missing" : geometry !== null ? "readable" : row[e.raw] && e.issues.some(i => i.code === "projection_required") ? "projection-required" : "unreadable";
    sample.rows.push({ index, values: Object.fromEntries(columns.map(c => [c.name, row[c.name]])), status });
    sample.features.features.push({ type: "Feature", id: index, geometry, properties: {} });
  });
  return sample;
}
