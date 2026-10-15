import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleAndSplit, filterSplitWithin, type WithinShape } from "./geometry";
import { osmPreviewAnswer, type OsmFeaturePreview } from "./preview-answer";
import { previewOsm } from "./import";

/**
 * OpenStreetMap Run Query previews under Bytes drawn per layer. The
 * features are placed and counted while they are assembled, so the
 * collection the preview used to build whole, every feature the response
 * holds, is never built: assembly stops once the answer is over the limit,
 * or once it is complete and more features are known. The answer is what
 * it was, points first, then lines, then polygons, up to the render cap
 * with truncation stated; equality is admitted, and one byte less refuses
 * it whole with 422 render_bytes_exceeded.
 */

const assembled = vi.hoisted(() => ({ features: 0 }));
vi.mock("osmtogeojson", async (original) => {
  const real = (await original<{ default: (...args: unknown[]) => unknown }>()).default;
  return {
    default: (data: unknown, options: unknown, each?: (feature: unknown) => void) => {
      if (each) return real(data, options, (feature: unknown) => { assembled.features++; each(feature); });
      const collection = real(data, options) as { features: unknown[] };
      assembled.features += collection.features.length;
      return collection;
    },
  };
});
const { fetchOverpass } = vi.hoisted(() => ({ fetchOverpass: vi.fn() }));
vi.mock("./overpass", async (original) => ({ ...(await original<typeof import("./overpass")>()), fetchOverpass }));

afterEach(() => {
  assembled.features = 0;
  fetchOverpass.mockReset();
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
});

type Element = Record<string, unknown>;
const node = (id: number, lon: number, lat: number, tags: Record<string, string> = { amenity: "bench" }): Element => ({ type: "node", id, lat, lon, tags });
const path = (points: [number, number][]) => points.map(([lon, lat]) => ({ lat, lon }));
/** A way; a ring that closes on its first point closes on its first node. */
const way = (id: number, points: [number, number][], tags: Record<string, string>): Element => {
  const closed = points.length > 3 && points[0].every((v, i) => v === points[points.length - 1][i]);
  const nodes = points.map((_, i) => id * 1000 + (closed && i === points.length - 1 ? 0 : i));
  return { type: "way", id, nodes, geometry: path(points), tags };
};
const ring = (x: number, y: number, size: number, vertices = 4): [number, number][] => {
  const corners: [number, number][] = Array.from({ length: vertices }, (_, i) => {
    const angle = (2 * Math.PI * i) / vertices;
    return [x + size * Math.cos(angle), y + size * Math.sin(angle)];
  });
  return [...corners, corners[0]];
};
const route = (id: number, ref: number, points: [number, number][]): Element =>
  ({ type: "relation", id, tags: { type: "route", route: "bus", name: `Line ${id}` }, members: [{ type: "way", ref, role: "", geometry: path(points) }] });
const multipolygon = (id: number, outer: [number, number][], name: string): Element =>
  ({ type: "relation", id, tags: { type: "multipolygon", landuse: "forest", name }, members: [{ type: "way", ref: id * 10, role: "outer", geometry: path(outer) }] });

/** Points, a route, a large forest assembled before the lines that may
 * push it out of the answer, lines and buildings interleaved, and a second
 * forest. */
const MIXED = {
  version: 0.6,
  elements: [
    node(1, 13.40, 52.50, { amenity: "restaurant", name: "Alpha \"Ä\"" }),
    node(2, 13.41, 52.51),
    route(100, 101, [[13.40, 52.50], [13.45, 52.52]]),
    multipolygon(200, ring(13.30, 52.45, 0.05, 400), "Large wood"),
    way(3, [[13.40, 52.50], [13.41, 52.51]], { highway: "residential", name: "B Street" }),
    way(4, ring(13.42, 52.52, 0.001), { building: "yes", name: "Hall" }),
    way(5, [[13.43, 52.53], [13.44, 52.54], [13.45, 52.53]], { highway: "path" }),
    way(6, ring(13.46, 52.52, 0.002), { building: "yes" }),
    multipolygon(300, ring(13.50, 52.40, 0.01), "Small wood"),
    way(7, [[13.47, 52.50], [13.48, 52.51]], { highway: "track" }),
  ],
};

/** Polygons only: the first polygon of the answer is its first feature. */
const POLYGONS = {
  version: 0.6,
  elements: [
    way(8, ring(13.42, 52.52, 0.001), { building: "yes", name: "One" }),
    multipolygon(400, ring(13.30, 52.45, 0.05, 40), "Wood"),
    way(9, ring(13.46, 52.52, 0.002), { building: "yes" }),
  ],
};

const PROMOTED = ["name", "highway"];
const NOT_EAST: WithinShape = { bbox: [13.0, 52.0, 13.455, 53.0] };

/** The preview as it was built before the byte limit: the whole
 * collection assembled and split, filtered, then capped. */
function previous(response: unknown, within: WithinShape | null, cap: number): OsmFeaturePreview {
  let split = assembleAndSplit(structuredClone(response), PROMOTED);
  if (within) split = filterSplitWithin(split, within);
  const all = [...split.points, ...split.lines, ...split.polygons];
  return { geojson: { type: "FeatureCollection", features: all.slice(0, cap) }, featureCount: Math.min(all.length, cap), truncated: all.length > cap, cap };
}

const answer = (response: unknown, within: WithinShape | null, cap: number, limit: number) =>
  osmPreviewAnswer(structuredClone(response), PROMOTED, within, cap, limit, () => {});
const bytesOf = (preview: OsmFeaturePreview) => Buffer.byteLength(JSON.stringify(preview), "utf8");
const SENTENCE = /^This query's features are larger than [\d,]+ bytes, the limit for one layer drawn in the map, too large to preview here\. Importing them is not affected\.$/;

const classes = (response: unknown) => {
  const split = assembleAndSplit(structuredClone(response), PROMOTED);
  return [split.points.length, split.lines.length, split.polygons.length];
};

describe("an OpenStreetMap preview under the byte limit", () => {
  it("draws its fixtures in the classes they stand for", () => {
    expect(classes(MIXED)).toEqual([2, 4, 4]);
    expect(classes(POLYGONS)).toEqual([0, 0, 3]);
  });

  it.each([
    ["mixed classes", MIXED, null],
    ["mixed classes, within an area", MIXED, NOT_EAST],
    ["polygons only", POLYGONS, null],
  ])("answers what it answered before at every cap, exactly at the limit, and refuses one byte under: %s", (_name, response, within) => {
    const total = previous(response, within, Number.MAX_SAFE_INTEGER).featureCount;
    expect(total).toBeGreaterThan(2);
    for (let cap = 0; cap <= total + 1; cap++) {
      const before = previous(response, within, cap);
      const limit = bytesOf(before);
      expect(answer(response, within, cap, limit), `cap ${cap}`).toEqual(before);
      expect(() => answer(response, within, cap, limit - 1), `cap ${cap}`).toThrow(SENTENCE);
    }
  });

  it("answers through the preview route's read with the render cap and the byte limit", async () => {
    fetchOverpass.mockImplementation(async () => ({ response: structuredClone(MIXED), fromCache: true }));
    const request = { ql: "nwr; out geom;", name: "source" };
    process.env.DEZFIL_RENDER_CAP_FEATURES = "4";
    const capped = await previewOsm(request);
    expect(capped).toMatchObject({ featureCount: 4, truncated: true, cap: 4 });
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(capped));
    expect(await previewOsm(request)).toEqual(capped);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(capped) - 1);
    await expect(previewOsm(request)).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422, message: expect.stringMatching(SENTENCE) });
  });
});

describe("an OpenStreetMap preview is decided before the collection is assembled", () => {
  const benches = (n: number, first = 1) => Array.from({ length: n }, (_, i) => node(first + i, 13.3 + (i % 100) * 0.0001, 52.4 + Math.floor(i / 100) * 0.0001));

  it("many small features: refused once the features counted pass the limit", async () => {
    fetchOverpass.mockImplementation(async () => ({ response: { version: 0.6, elements: benches(20000) }, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_BYTES = "65536";
    await expect(previewOsm({ ql: "nwr; out geom;", name: "source" })).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(assembled.features).toBeGreaterThan(0);
    expect(assembled.features).toBeLessThanOrEqual(1000);
  });

  it("one oversized feature: refused without assembling the features after it", async () => {
    const long = Array.from({ length: 50000 }, (_, i): [number, number] => [13.3 + i * 1e-6, 52.4 + (i % 2) * 1e-4]);
    const elements = [way(1, long, { highway: "primary" }), ...Array.from({ length: 20000 }, (_, i) => way(2 + i, [[13.3, 52.4], [13.31, 52.41]], { highway: "service" }))];
    fetchOverpass.mockImplementation(async () => ({ response: { version: 0.6, elements }, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_BYTES = "65536";
    await expect(previewOsm({ ql: "nwr; out geom;", name: "source" })).rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(assembled.features).toBe(1);
  });

  it("stops as soon as later lines push a held polygon out of a complete answer", async () => {
    // The forest is assembled first and held; the second street completes
    // a two-feature answer, so the forest is known to be left out.
    const streets = Array.from({ length: 2000 }, (_, i) => way(10 + i, [[13.3, 52.4], [13.31, 52.41]], { highway: "service" }));
    fetchOverpass.mockImplementation(async () => ({ response: { version: 0.6, elements: [multipolygon(500, ring(13.3, 52.4, 0.01), "Wood"), ...streets] }, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_FEATURES = "2";
    const preview = await previewOsm({ ql: "nwr; out geom;", name: "source" });
    expect(preview).toMatchObject({ featureCount: 2, truncated: true });
    expect(preview.geojson.features.map((f) => (f as { properties: { osm_id: string } }).properties.osm_id)).toEqual(["way/10", "way/11"]);
    expect(assembled.features).toBe(3);
  });

  it("stops once the capped answer is complete and more features are known", async () => {
    fetchOverpass.mockImplementation(async () => ({ response: { version: 0.6, elements: benches(20000) }, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_FEATURES = "5";
    const preview = await previewOsm({ ql: "nwr; out geom;", name: "source" });
    expect(preview).toMatchObject({ featureCount: 5, truncated: true, cap: 5 });
    expect(assembled.features).toBe(6);
  });
});
