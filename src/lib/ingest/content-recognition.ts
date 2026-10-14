import { isTrustedOperationRefusal } from "@/lib/trusted-operation";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { GeometryCandidate, GeometryFormat, GeometryRecord } from "@/lib/geometry-evidence";
import { geometryColumnName, orderedNameMatches, type CsvColumn } from "./csv-geometry";
import { crsEvidence, decoderSql, placementStatsSql, presentSql, shapedFormats } from "./content-decoders";
import { readCrsDeclarations } from "./content-crs";
import { orderCandidates, sampledPairs } from "./content-pairs";
import { ident, lit } from "./sql";

interface Reading {
  candidate: GeometryCandidate;
  geometry: string;
  unreadableCount: number;
}
export interface ContentRecognition {
  select: string;
  crsAssumed: boolean;
  geometryRecord: GeometryRecord | null;
  geometryCandidates: GeometryCandidate[];
}

async function reading(
  conn: DuckDBConnection, from: string, sample: string, columns: string[],
  format: GeometryFormat, rule: GeometryCandidate["rule"],
): Promise<Reading | null> {
  const decode = decoderSql(format, columns);
  const present = presentSql(columns);
  const stats = (relation: string) => `SELECT count(*) n, count(*) FILTER (WHERE ${present}) non_null,
    count(*) FILTER (WHERE ${decode} IS NOT NULL) readable FROM ${relation}`;
  const sampled = (await conn.runAndReadAll(stats(sample))).getRowObjects()[0];
  const sampleFacts = { rows: Number(sampled.n), nonNull: Number(sampled.non_null), readable: Number(sampled.readable) };
  if (rule === "content" && sampleFacts.readable === 0) return null;

  // Full-input declaration and placement truth is deliberately separate from
  // sampled recognition strength. No full column crosses into JavaScript.
  const { declarations, unknown } = await readCrsDeclarations(conn, from, format, columns[0]);
  let crs = crsEvidence(format, declarations);
  const reasons: string[] = [];
  if (unknown) {
    reasons.push("unknown-crs");
    crs = { stance: "unknown", srid: null, label: "Unknown CRS declaration" };
  }
  let place: ((geometry: string) => string) | null = null;
  if (crs.stance === "conflicting") reasons.push("conflicting-crs");
  if (crs.stance === "declared" && crs.srid !== 4326) {
    // Even an all-bad named column must not silently accept an unknown CRS.
    try {
      await conn.runAndReadAll(`SELECT ST_Transform(ST_Point(0, 0), ${lit(`EPSG:${crs.srid}`)}, 'EPSG:4326', always_xy := true)`);
      const srid = lit(`EPSG:${crs.srid}`);
      place = (geometry) => `TRY(ST_Transform(${geometry}, ${srid}, 'EPSG:4326', always_xy := true))`;
    } catch (error) {
      if (isTrustedOperationRefusal(error)) throw error;
      reasons.push("untransformable-crs");
    }
  }
  const geometry = place ? place(decode) : decode;
  const full = (await conn.runAndReadAll(placementStatsSql(from, present, decode, place))).getRowObjects()[0];
  if (Number(full.failed_transform)) reasons.push("untransformable-crs");
  if (Number(full.unsafe)) reasons.push("outside-degree-range");
  const named = rule !== "content";
  if (named && sampleFacts.nonNull > 0 && sampleFacts.readable === 0) reasons.push("unreadable");
  const strong = (named || (sampleFacts.nonNull > 0 && sampleFacts.readable === sampleFacts.nonNull)) && reasons.length === 0;
  if (!named && sampleFacts.readable < sampleFacts.nonNull) reasons.push("partially-readable");
  const candidate: GeometryCandidate = {
    columns, format, signal: named ? "name" : "content", rule,
    strength: strong ? "strong" : "weak", sample: sampleFacts, crs,
    degreeCompatible: Number(full.source_unsafe) === 0,
    reasons: [...new Set(reasons)], applied: false, sourceRetained: true,
    ...(format === "pair" ? { orientations: [{ lon: columns[0], lat: columns[1] }] } : {}),
  };
  return { candidate, geometry: `ST_SetCRS(${geometry}, 'OGC:CRS84')`, unreadableCount: Number(full.unreadable) };
}

/** CSV reader-only planning. Owns a stored-table entry point and its tests. */
export async function recognizeCsvContent(
  conn: DuckDBConnection,
  from: string,
  columns: readonly CsvColumn[],
  h3Ready: () => Promise<boolean>,
): Promise<ContentRecognition> {
  // A connection-local bounded snapshot preserves the first 1,000 reader rows.
  // Reserved temporary names never collide with source column identifiers.
  const sampleName = `csv_sample_${crypto.randomUUID().replaceAll("-", "")}`;
  const sample = ident(sampleName);
  await conn.run(`CREATE TEMP TABLE ${sample} AS SELECT * FROM ${from} LIMIT 1000`);
  try {
    const rows = (await conn.runAndReadAll(`SELECT * FROM ${sample}`)).getRowObjects() as Record<string, unknown>[];
    const readings: Reading[] = [];
    for (const match of orderedNameMatches(columns)) {
      const r = await reading(conn, from, sample, match.columns, match.format, match.rule);
      if (r) readings.push(r);
    }
    const hints: GeometryCandidate[] = [];
    for (const column of columns) {
      if (!column.type.startsWith("VARCHAR")) continue;
      const values = rows.map(r => r[column.name]);
      for (const format of shapedFormats(values)) {
        if (readings.some(r => r.candidate.columns[0] === column.name && r.candidate.format === format)) continue;
        if (format === "h3" && !await h3Ready()) {
          hints.push({
            columns: [column.name], format, signal: "content", rule: "content", strength: "weak",
            sample: { rows: rows.length, nonNull: values.filter(v => v !== null).length, readable: null },
            crs: { stance: "unknown", srid: null, label: "Unvalidated H3" }, degreeCompatible: null,
            reasons: ["h3-unavailable"], applied: false, sourceRetained: true,
          });
          continue;
        }
        const r = await reading(conn, from, sample, [column.name], format, "content");
        if (r) readings.push(r);
      }
    }
    const selected = readings.find(r => r.candidate.strength === "strong");
    const pairs = sampledPairs(columns, rows).filter(p => !readings.some(r =>
      r.candidate.format === "pair" && p.columns.every(c => r.candidate.columns.includes(c))));
    if (selected) {
      selected.candidate.applied = true;
      if (selected.candidate.rule === "wkt-name") {
        for (const r of readings) if (r.candidate.columns.includes(selected.candidate.columns[0])) r.candidate.sourceRetained = false;
      }
    }
    const candidates = orderCandidates([...readings.map(r => r.candidate), ...pairs, ...hints], columns);
    if (!selected) return { select: `SELECT * FROM ${from}`, crsAssumed: false, geometryRecord: null, geometryCandidates: candidates };
    const c = selected.candidate;
    const retained = columns.map(col => col.name).filter(name => c.sourceRetained || name !== c.columns[0]);
    const projection = c.sourceRetained ? "*" : `* EXCLUDE (${ident(c.columns[0])})`;
    return {
      select: `SELECT ${projection}, ${selected.geometry} AS ${ident(geometryColumnName(retained))} FROM ${from}`,
      crsAssumed: c.crs.stance === "assumed",
      geometryRecord: { columns: c.columns, format: c.format, signal: c.signal, rule: c.rule, crs: c.crs, unreadableCount: selected.unreadableCount },
      geometryCandidates: candidates,
    };
  } finally {
    await conn.run(`DROP TABLE ${sample}`);
  }
}

/** Same evidence and preference order as upload, without applying the proposed
 * selection or claiming that a currently stored source has been consumed. */
export async function recognizeStoredContent(
  conn: DuckDBConnection, from: string, columns: readonly CsvColumn[],
  h3Ready: () => Promise<boolean>, current: { format: GeometryFormat; columns: string[] } | null,
): Promise<GeometryCandidate[]> {
  const result = await recognizeCsvContent(conn, from, columns, h3Ready);
  return result.geometryCandidates.map(c => ({
    ...c, sourceRetained: true,
    applied: current !== null && c.format === current.format &&
      c.columns.length === current.columns.length && c.columns.every((name, i) => name === current.columns[i]),
  })).sort((a, b) => Number(b.applied) - Number(a.applied));
}
