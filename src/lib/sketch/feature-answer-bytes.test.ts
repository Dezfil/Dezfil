import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection, DuckDBVarCharVector, type DuckDBResult } from "@duckdb/node-api";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { retirementsSettled } from "@/lib/ingest/retire";
import { withConnection } from "@/lib/duckdb";
import { lit } from "@/lib/ingest/sql";
import { readFeatures, type StoredSketchFeature } from "./read";
import { appendFeature, createSketch, deleteFeature, listFeatures, moveVertex } from "./store";

/**
 * A sketch's features read under Bytes drawn per layer: the complete
 * answer, {"features":[…]}, is admitted exactly at the limit and refused
 * whole one byte under with 422 render_bytes_exceeded, before it is built.
 * The reads a change makes of the sketch are not held to the limit, so a
 * sketch too large to read whole can still be changed.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await retirementsSettled();
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  await rm(dir, { recursive: true, force: true });
});

const square = { kind: "polygon", geometry: { type: "Polygon", coordinates: [[[13.4, 52.5], [13.5, 52.5], [13.5, 52.6], [13.4, 52.6], [13.4, 52.5]]] } };
const line = { kind: "line", geometry: { type: "LineString", coordinates: [[0.30000000000000004, 52], [13.400000000000002, 52.6]] } };
const point = { kind: "point", geometry: { type: "Point", coordinates: [1e-7, 50.25] } };

async function sketch(...more: object[]): Promise<DataTable> {
  const map = createMap(testAccountScope(), "Survey");
  const made = await createSketch(testAccountScope(), map.id, square, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })?.editRevision });
  for (const feature of more) await appendFeature(testAccountScope(), made.table.name, feature);
  return getTableByName(made.table.name)!;
}

const read = (table: DataTable) => listFeatures(testAccountScope(), table.name);
/** The bytes of the complete answer the features read sends. */
const bytesOf = (features: StoredSketchFeature[]) => Buffer.byteLength(JSON.stringify({ features }), "utf8");
const artifact = (table: DataTable) => path.join(process.env.DEZFIL_DATA_DIR!, table.file);
const SENTENCE = /^This sketch's features are larger than [\d,]+ bytes, the limit for one layer drawn in the map\. Raise DEZFIL_RENDER_CAP_BYTES and restart to edit it\.$/;

describe("a sketch's features under the byte limit", () => {
  it("answers what it answered before exactly at the limit, and refuses one byte under", async () => {
    const table = await sketch(line, point);
    const whole = await read(table);
    // The read as it was before the limit: the engine's GeoJSON, parsed whole.
    expect(whole).toEqual(await readFeatures(artifact(table)));
    expect(whole.map((f) => f.kind)).toEqual(["polygon", "line", "point"]);

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await read(table)).toEqual(whole);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422, message: expect.stringMatching(SENTENCE) });
  });

  it("counts a feature without a kind as the text it is answered with", async () => {
    const table = await sketch();
    await rewrite(table, "SELECT 'f0' AS feature_id, CAST(NULL AS VARCHAR) AS kind, ST_Point(13.4, 52.5) AS geom");
    const whole = await read(table);
    expect(whole).toEqual(await readFeatures(artifact(table)));
    expect(whole[0].kind).toBe("null");
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await read(table)).toEqual(whole);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
  });

  it("counts an emptied sketch's answer too", async () => {
    const table = await sketch();
    const [only] = await read(table);
    await deleteFeature(testAccountScope(), table.name, only.id);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf([]));
    expect(await read(table)).toEqual([]);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf([]) - 1);
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
  });

  it("still changes a sketch too large to read whole", async () => {
    const table = await sketch(line);
    const [first, second] = await read(table);
    process.env.DEZFIL_RENDER_CAP_BYTES = "64";
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded" });

    expect(await appendFeature(testAccountScope(), table.name, point)).toMatchObject({ rowCount: 3 });
    expect(await moveVertex(testAccountScope(), table.name, first.id, 0, [13.41, 52.51])).toMatchObject({ rowCount: 3 });
    expect(await deleteFeature(testAccountScope(), table.name, second.id)).toMatchObject({ rowCount: 2 });

    delete process.env.DEZFIL_RENDER_CAP_BYTES;
    const after = await read(table);
    expect(after.map((f) => f.kind)).toEqual(["polygon", "point"]);
    expect((after[0].geometry as { coordinates: number[][][] }).coordinates[0][0]).toEqual([13.41, 52.51]);
  });
});

/** Rows streamed into the answer, and the longest text converted from
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

/** The sketch's artifact rewritten in place with these rows. */
async function rewrite(table: DataTable, select: string): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(`COPY (${select}) TO ${lit(artifact(table))} (FORMAT PARQUET)`);
  });
}

describe("an oversized sketch answer is refused before it is built", () => {
  const LIMIT = 65_536;

  it("many small features: refused within the chunk that crosses the limit", async () => {
    const table = await sketch();
    await rewrite(table, "SELECT 'f' || i AS feature_id, 'point' AS kind, ST_Point(13.3 + i * 1e-5, 52.4) AS geom FROM range(20000) t(i)");
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.rows).toBeGreaterThan(0);
    expect(seen.rows).toBeLessThanOrEqual(2048);
  });

  it("one oversized geometry: refused before its text is converted", async () => {
    const table = await sketch();
    const ring = Array.from({ length: 9000 }, (_, i) => `${13.3 + i * 1e-6} ${52.4 + (i % 2) * 1e-4}`);
    await rewrite(table, `SELECT 'f0' AS feature_id, 'line' AS kind, ST_GeomFromText('LINESTRING (${ring.join(", ")})') AS geom`);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(read(table)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.longestText).toBeLessThanOrEqual(LIMIT);
  });
});
