import type { DuckDBConnection } from "@duckdb/node-api";
import { trustedH3Ready } from "@/lib/duckdb";
import type { GeometryCrs } from "@/lib/geometry-evidence";
import { crsEvidence, decoderSql, degreeSql, presentSql } from "@/lib/ingest/content-decoders";
import { ident, lit } from "@/lib/ingest/sql";
import { readCrsDeclarations } from "@/lib/ingest/content-crs";
import { projectionSupported } from "./projections";
import type { GeometryChoice, GeometryIssue } from "./types";
import { stageGeometry } from "./stage";

/** A SQL plan with collision-proof working names. Full input remains in DuckDB. */
export async function evaluateGeometry(conn: DuckDBConnection, from: string, choice: GeometryChoice, native = false, sampleRows?: number, accountId?: string) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const raw = `raw_${suffix}`, present = `present_${suffix}`, placed = `placed_${suffix}`, output = `output_${suffix}`;
  const issues: GeometryIssue[] = [];
  let crs: GeometryCrs = crsEvidence(choice.format, []);
  if (!native) {
    const { declarations, unknown } = await readCrsDeclarations(conn, from, choice.format, choice.columns[0]);
    crs = crsEvidence(choice.format, declarations);
    if (crs.stance === "conflicting") issues.push({ code: "conflicting_crs", message: "The column contains conflicting CRS declarations." });
    if (unknown) issues.push({ code: "unknown_crs", message: "The column contains an unreadable CRS declaration." });
  }
  if (choice.epsg !== undefined) {
    if (crs.stance === "declared" && crs.srid !== choice.epsg) {
      issues.push({ code: "conflicting_crs", message: `The column declares EPSG:${crs.srid}. A different projection cannot override it.` });
    } else if (issues.length === 0) crs = crsEvidence("wkt", [choice.epsg]);
  }
  const epsg = crs.srid ?? 4326;
  if (issues.length === 0 && !await projectionSupported(conn, epsg)) issues.push({ code: "unsupported_projection", message: `EPSG:${epsg} cannot be transformed to WGS 84.` });
  let decode = native ? ident(choice.columns[0]) : decoderSql(choice.format, choice.columns, true);
  if (choice.format === "h3" && !native && !await trustedH3Ready()) {
    issues.push({ code: "h3_unavailable", message: "H3 validation is unavailable on this instance." });
    decode = "NULL::GEOMETRY";
  }
  if (!native && choice.format === "pair") decode = `CASE WHEN ${presentSql(choice.columns)} THEN ST_Point(TRY_CAST(${ident(choice.columns[0])} AS DOUBLE), TRY_CAST(${ident(choice.columns[1])} AS DOUBLE)) END`;
  // A physical stage makes the parse and vertex check
  // reusable across the degree verdict, measurement and artifact write.
  // A subquery/CTE alone is inlined anew by each separate SQL statement.
  const fitsColumn = ident(`fits_${suffix}`);
  const input = sampleRows === undefined ? from : `(SELECT * FROM ${from} LIMIT ${sampleRows})`;
  const decoded = `SELECT *, ${presentSql(choice.columns)} AS ${ident(present)}, ${decode} AS ${ident(raw)} FROM ${input}`;
  const { from: stage, dispose } = await stageGeometry(conn,
    `SELECT *, ${degreeSql(ident(raw))} AS ${fitsColumn} FROM (${decoded})`, sampleRows === undefined, accountId);
  try {
    const nonempty = `${ident(raw)} IS NOT NULL AND NOT ST_IsEmpty(${ident(raw)})`;
    const stats = (await conn.runAndReadAll(`SELECT count(*) FILTER (WHERE ${nonempty}) n,
      count(*) FILTER (WHERE ${nonempty} AND ${fitsColumn}) fits FROM ${stage}`)).getRowObjects()[0];
    const n = Number(stats.n), fits = Number(stats.fits);
    const degreeCompatible = n === 0 ? null : n === fits;
    if (issues.length === 0 && epsg === 4326 && n > 0 && fits === 0) issues.push({ code: "projection_required", message: "These numbers are not degrees. Choose their source projection." });
    const transform = issues.length ? "NULL::GEOMETRY" : epsg === 4326 ? ident(raw)
      : `TRY(ST_Transform(${ident(raw)}, ${lit(`EPSG:${epsg}`)}, 'EPSG:4326', always_xy := true))`;
    const transformed = `SELECT *, ${transform} AS ${ident(placed)} FROM ${stage}`;
    const placedFits = epsg === 4326 ? fitsColumn : degreeSql(ident(placed));
    const evaluated = `SELECT *, ST_SetCRS(CASE WHEN ${placedFits} THEN ${ident(placed)} END, 'OGC:CRS84') AS ${ident(output)} FROM (${transformed})`;
    return { from: `(${evaluated})`, raw, present, placed, output, crs, issues, degreeCompatible, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type EvaluatedGeometry = Awaited<ReturnType<typeof evaluateGeometry>>;
