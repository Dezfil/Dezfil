import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { DuckDBConnection, DuckDBVarCharVector, type DuckDBResult } from "@duckdb/node-api";
import { setupGeometryTest, cleanupGeometryTest } from "@/lib/test-support/geometry";
import { withConnection } from "@/lib/duckdb";
import { lit } from "@/lib/ingest/sql";
import { limits } from "@/lib/limits";
import { previewOvertureFeatures, type FeaturePreview, type OvertureImportParams } from "./import";
import { buildOverturePreview } from "./query";
import type { Bbox } from "@/lib/bbox";

/**
 * Run Query previews of an Overture selection under Bytes drawn per layer:
 * the complete answer, envelope included, is admitted exactly at the limit;
 * above it the preview is refused whole with 422 render_bytes_exceeded and
 * no partial result, before it is built. The render cap still samples the
 * first features and `truncated` still states whether more matched.
 *
 * The remote release is stood in for by a local GeoParquet of the same
 * shape; the selection's filters are the import's own.
 */

let fixture = "";
vi.mock("./remote", async (original) => ({ ...(await original<typeof import("./remote")>()), ensureOvertureSupport: async () => {} }));
vi.mock("./query", async (original) => {
  const real = await original<typeof import("./query")>();
  return {
    ...real,
    buildOverturePreview: (...args: Parameters<typeof real.buildOverturePreview>) =>
      real.buildOverturePreview(...args).replace(/read_parquet\(\[[^\]]*\][^)]*\)/, `read_parquet(${lit(fixture)})`),
  };
});

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await cleanupGeometryTest(dir);
});

/** A release-shaped file: the geometry and its bounding box. */
async function release(select: string): Promise<void> {
  fixture = path.join(process.env.DEZFIL_DATA_DIR!, "release.parquet");
  await withConnection(async (conn) => {
    await conn.run(`COPY (SELECT geometry, struct_pack(xmin := ST_XMin(geometry), ymin := ST_YMin(geometry),
      xmax := ST_XMax(geometry), ymax := ST_YMax(geometry)) AS bbox FROM (${select})) TO ${lit(fixture)} (FORMAT PARQUET)`);
  });
}

const BBOX: Bbox = [13.3, 52.4, 13.32, 52.42];
const params: OvertureImportParams = { theme: "buildings", release: "2026-06-17.0", scope: { type: "bbox", bbox: BBOX }, semantics: "intersect" };
const preview = () => previewOvertureFeatures(params);
const bytesOf = (answer: FeaturePreview) => Buffer.byteLength(JSON.stringify(answer), "utf8");
const SENTENCE = /^This selection's features are larger than [\d,]+ bytes, the limit for one layer drawn in the map, too large to preview here\. Importing them is not affected\.$/;

/** The preview as it was built before the byte limit: the engine's GeoJSON
 * text for each of the first rows, parsed whole, then capped. */
async function previous(cap: number): Promise<FeaturePreview> {
  const sql = buildOverturePreview({ theme: params.theme, release: params.release, scope: { kind: "bbox", bbox: BBOX }, semantics: params.semantics }, cap)
    .replace("SELECT geometry FROM", "SELECT ST_AsGeoJSON(geometry) AS geometry FROM")
    .replace(" AND geometry IS NOT NULL", "");
  const all = await withConnection(async (conn) => (await conn.runAndReadAll(sql)).getRowObjects() as { geometry: unknown }[]);
  const features = all.slice(0, cap).filter((r) => r.geometry !== null && r.geometry !== undefined)
    .map((r, i) => ({ type: "Feature", id: i, geometry: JSON.parse(String(r.geometry)) as unknown, properties: {} }));
  return { geojson: { type: "FeatureCollection", features }, featureCount: features.length, truncated: all.length > cap, cap };
}

const MIXED = `SELECT * FROM (VALUES
  (ST_GeomFromText('POINT (13.31 52.41)')),
  (ST_GeomFromText('POLYGON ((13.30 52.40, 13.3125 52.40, 13.3125 52.4105, 13.30 52.40))')),
  (ST_GeomFromText('LINESTRING (13.300000000000001 52.41, 13.31 52.419999999999995)')),
  (ST_GeomFromText('MULTIPOLYGON (((13.30 52.40, 13.301 52.40, 13.301 52.401, 13.30 52.40)), ((13.305 52.405, 13.306 52.405, 13.306 52.406, 13.305 52.405)))')),
  (ST_GeomFromText('POINT (13.315 52.415)'))
) AS v(geometry)`;

describe("an Overture preview under the byte limit", () => {
  it("previews what it previewed before exactly at the limit, and refuses one byte under", async () => {
    await release(MIXED);
    const whole = await preview();
    expect(whole).toMatchObject({ featureCount: 5, truncated: false, cap: limits.renderCapFeatures });
    expect(whole).toEqual(await previous(limits.renderCapFeatures));

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await preview()).toEqual(whole);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    await expect(preview()).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422, message: expect.stringMatching(SENTENCE) });
  });

  it("keeps the render cap's sample and its truncation, counted as sent", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    await release(MIXED);
    const sample = await preview();
    expect(sample).toMatchObject({ featureCount: 3, truncated: true, cap: 3 });
    expect(sample).toEqual(await previous(3));
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sample));
    expect(await preview()).toEqual(sample);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sample) - 1);
    await expect(preview()).rejects.toMatchObject({ code: "render_bytes_exceeded" });
  });

  it("answers the byte refusal, not a remote failure, whatever digits the limit has", async () => {
    // A limit of 405,000 puts an HTTP-status-shaped number in the sentence.
    await release("SELECT ST_Point(13.3 + (i % 100) * 0.0001, 52.4 + (i // 100) * 0.0001) AS geometry FROM range(20000) t(i)");
    process.env.DEZFIL_RENDER_CAP_BYTES = "405000";
    await expect(preview()).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422, message: expect.stringContaining("405,000 bytes") });
  });
});

/** Rows streamed into a preview, and the longest text converted from
 * native storage, while it is read. */
function observe() {
  const seen = { rows: 0, longestText: 0 };
  const stream = DuckDBConnection.prototype.stream;
  vi.spyOn(DuckDBConnection.prototype, "stream").mockImplementation(async function (this: DuckDBConnection, ...args: Parameters<DuckDBConnection["stream"]>) {
    const result: DuckDBResult = await stream.apply(this, args);
    const fetch = result.fetchChunk.bind(result);
    result.fetchChunk = async () => { const chunk = await fetch(); seen.rows += chunk?.rowCount ?? 0; return chunk; };
    return result;
  });
  const item = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index: number) {
    const text = item.call(this, index);
    if (text !== null) seen.longestText = Math.max(seen.longestText, Buffer.byteLength(text));
    return text;
  });
  return seen;
}

describe("an oversized Overture preview is refused before it is built", () => {
  const LIMIT = 65_536;

  it("many small features: refused within the chunk that crosses the limit", async () => {
    await release("SELECT ST_Point(13.3 + (i % 100) * 0.0001, 52.4 + (i // 100) * 0.0001) AS geometry FROM range(20000) t(i)");
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(preview()).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.rows).toBeGreaterThan(0);
    expect(seen.rows).toBeLessThanOrEqual(2048);
  });

  it("one oversized geometry: refused before its text is converted", async () => {
    const line = Array.from({ length: 50000 }, (_, i) => `${13.3 + i * 1e-7} ${52.4 + (i % 2) * 1e-4}`);
    await release(`SELECT ST_GeomFromText('LINESTRING (${line.join(", ")})') AS geometry`);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(preview()).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.longestText).toBeLessThanOrEqual(LIMIT);
  });
});
