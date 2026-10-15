import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection, DuckDBVarCharVector, type DuckDBResult } from "@duckdb/node-api";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, sliderPreviewData, updateLayer } from "@/lib/layer-service";
import { boundedEvaluation } from "@/lib/query/bounded";
import { namedSql } from "@/lib/query/named-sql";
import { layerEvaluation } from "@/lib/query/context";
import type { Layer } from "@/lib/metadata/maps";
import type { SliderPreviewData } from "@/lib/slider-preview";

/**
 * Slider previews under Bytes drawn per layer: the complete answer,
 * envelope included, is admitted exactly at the limit; above it the preview
 * is refused whole with 422 render_bytes_exceeded, before it is built, and
 * the layer's own render, evaluated when the slider settles, still draws.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  delete process.env.DEZFIL_SLIDER_PREVIEW_ROWS;
  await rm(dir, { recursive: true, force: true });
});

async function points(rows: number, payload: (i: number) => string) {
  const lines = ["id,riders,payload,lon,lat"];
  for (let i = 0; i < rows; i++) lines.push(`${i},${(i * 37) % 1000},${payload(i)},${13.3 + (i % 50) * 0.001},${52.4 + Math.floor(i / 50) * 0.001}`);
  const src = path.join(dir, "points.csv");
  await writeFile(src, lines.join("\n"));
  await ingestFile(testAccountScope(), src, "points.csv");
}

const revision = (mapId: string) => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });
const rgba = { r: 20, g: 30, b: 40, a: 1 };

/** A points layer with a range filter on riders and its label on the
 * payload, so the preview carries both. */
async function sliderLayer(min = 500, fields: Partial<Pick<Layer, "viz">> = {}): Promise<Layer> {
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(testAccountScope(), map.id, { name: "Points", sql: "SELECT id, riders, payload, geometry FROM points" }, revision(map.id));
  return updateLayer(testAccountScope(), layer.id, {
    ...fields,
    filters: [{ field: "riders", kind: "range", min, max: null }],
    style: { ...layer.style, label: { attribute: "payload", size: 12, color: rgba, haloWidth: 1, haloColor: rgba } },
  }, revision(map.id));
}

const preview = (layer: Layer) => sliderPreviewData(testAccountScope(), layer);
const bytesOf = (answer: SliderPreviewData) => Buffer.byteLength(JSON.stringify(answer), "utf8");
const SENTENCE = /^This layer's preview is larger than [\d,]+ bytes, the limit for one layer drawn in the map, so the map shows the change when you let go\.$/;

/** The features as previews were built before the byte limit: the engine's
 * GeoJSON and to_json texts, parsed whole. */
async function previous(layer: Layer, answer: SliderPreviewData): Promise<unknown[]> {
  const props = `to_json({${answer.fields.map((f) => `'${f.name}': "${f.name}"`).join(", ")}})`;
  return boundedEvaluation(async (conn) => {
    const sql = await namedSql(conn, layer.sql);
    const rows = await conn.runAndReadAll(`SELECT ST_AsGeoJSON(geometry) AS g, ${props} AS p FROM (${sql}) AS q
      WHERE geometry IS NOT NULL ${answer.exact ? "" : `ORDER BY hash(ST_AsWKB(geometry), ${answer.fields.map((f) => `"${f.name}"`).join(", ")})`} LIMIT ${answer.budget}`);
    return rows.getRowObjects().map((r) => ({ type: "Feature", geometry: JSON.parse(String(r.g)), properties: JSON.parse(String(r.p)) }));
  }, { scope: layerEvaluation(testAccountScope(), layer) });
}

describe("a slider preview under the byte limit", () => {
  it("previews what it previewed before exactly at the limit, and refuses one byte under", async () => {
    await points(40, (i) => `tag "${i}" é`);
    const layer = await sliderLayer();
    const whole = await preview(layer);
    expect(whole).toMatchObject({ exact: true, sourceCount: 40, sampledCount: 40, fields: [{ name: "riders" }, { name: "payload" }] });
    expect(JSON.stringify((whole.geojson as { features: unknown[] }).features)).toBe(JSON.stringify(await previous(layer, whole)));

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await preview(layer)).toEqual(whole);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    await expect(preview(layer)).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422, message: expect.stringMatching(SENTENCE) });
  });

  it("counts a bounded, hash-ordered subset as it is sent", async () => {
    await points(40, (i) => `p${i}`);
    process.env.DEZFIL_SLIDER_PREVIEW_ROWS = "7";
    const layer = await sliderLayer();
    const sample = await preview(layer);
    expect(sample).toMatchObject({ exact: false, sourceCount: 40, sampledCount: 7, budget: 7 });
    expect(JSON.stringify((sample.geojson as { features: unknown[] }).features)).toBe(JSON.stringify(await previous(layer, sample)));
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sample));
    expect(await preview(layer)).toEqual(sample);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sample) - 1);
    await expect(preview(layer)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
  });

  it("leaves the settled layer to draw when its preview is refused", async () => {
    // The preview carries every row, since a slider can widen; the settled
    // layer applies its filter in the query and is far smaller.
    await points(400, () => "x".repeat(200));
    const layer = await sliderLayer(990, { viz: { type: "cluster", radiusPx: 64, color: "fixed", showCounts: true } });
    process.env.DEZFIL_RENDER_CAP_BYTES = "32768";
    await expect(preview(layer)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    const settled = await renderLayer(testAccountScope(), layer);
    expect(settled).toMatchObject({ ok: true, mode: "inline" });
    expect(settled.featureCount).toBeGreaterThan(0);
  });
});

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

describe("an oversized preview is refused before it is built", () => {
  const LIMIT = 65_536;

  it("many small features: refused within the chunk that crosses the limit", async () => {
    await points(20000, () => "x".repeat(64));
    const layer = await sliderLayer();
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(preview(layer)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.rows).toBeLessThanOrEqual(2048);
  });

  it("one oversized value: refused before it is converted", async () => {
    await points(3, (i) => (i === 1 ? "x".repeat(1536 * 1024) : "small"));
    const layer = await sliderLayer(0);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    await expect(preview(layer)).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(seen.longestText).toBeLessThanOrEqual(LIMIT);
  });
});
