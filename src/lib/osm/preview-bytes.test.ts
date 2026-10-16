import { afterEach, describe, expect, it, vi } from "vitest";
import { limits } from "@/lib/limits";
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

/** Features the assembler handed over, and whether it is running now, so
 * that a read of a raw coordinate can be told apart as construction. */
const assembled = vi.hoisted(() => ({ features: 0, running: false }));
vi.mock("osmtogeojson", async (original) => {
  const real = (await original<{ default: (...args: unknown[]) => unknown }>()).default;
  return {
    default: (data: unknown, options: unknown, each?: (feature: unknown) => void) => {
      assembled.running = true;
      try {
        if (each) return real(data, options, (feature: unknown) => { assembled.features++; each(feature); });
        const collection = real(data, options) as { features: unknown[] };
        assembled.features += collection.features.length;
        return collection;
      } finally {
        assembled.running = false;
      }
    },
  };
});
const { fetchOverpass } = vi.hoisted(() => ({ fetchOverpass: vi.fn() }));
vi.mock("./overpass", async (original) => ({ ...(await original<typeof import("./overpass")>()), fetchOverpass }));

afterEach(() => {
  vi.restoreAllMocks();
  assembled.features = 0;
  assembled.running = false;
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

/**
 * Construction is observed on the raw element itself: every read of a
 * vertex's coordinates while the assembler runs (it reads both of each
 * vertex to build its pair), apart from the reads outside it, and every
 * serialization of its tags.
 */
interface Watched { coordinates: number; measured: number; tags: number }
const watching = (): Watched => ({ coordinates: 0, measured: 0, tags: 0 });

/** A raw geometry whose coordinate reads are counted. */
const watchedPath = (points: [number, number][], seen: Watched) => points.map(([lon, lat]) => {
  const read = () => { if (assembled.running) seen.coordinates++; else seen.measured++; };
  return { get lat() { read(); return lat; }, get lon() { read(); return lon; } };
});

/** Counts each serialization of these tags. */
function watchTags(tags: object, seen: Watched) {
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation(function (value: unknown, ...rest: unknown[]) {
    if (value === tags) seen.tags++;
    return (stringify as (...args: unknown[]) => string)(value, ...rest);
  });
}

/**
 * One element too large for the answer on its own is refused before the
 * assembler builds it: a refusal is early only when the assembler read
 * none of its coordinates and its tags were never serialized.
 */
describe("an element too large on its own is refused before it is assembled", () => {
  const LIMIT = 65_536;
  const long = (n: number) => Array.from({ length: n }, (_, i): [number, number] => [13.3 + i * 1e-6, 52.4 + (i % 2) * 1e-4]);
  const streets = (n: number, first: number) => Array.from({ length: n }, (_, i) => way(first + i, [[13.3, 52.4], [13.31, 52.41]], { highway: "service" }));

  /** Each case builds a fresh response around one oversized element. */
  const cases: [string, (seen: Watched) => { response: { version: number; elements: Element[] }; tags: object }][] = [
    ["one 50,000-vertex way", (seen) => {
      const tags = { highway: "primary" };
      const element = { ...way(1, long(50000), tags), geometry: watchedPath(long(50000), seen) };
      return { response: { version: 0.6, elements: [element, ...streets(20000, 2)] }, tags };
    }],
    ["one multipolygon with a 50,000-vertex ring", (seen) => {
      const tags = { type: "multipolygon", landuse: "forest", name: "Wood" };
      const element = { type: "relation", id: 9, tags, members: [{ type: "way", ref: 90, role: "outer", geometry: watchedPath(ring(13.3, 52.4, 0.05, 50000), seen) }] };
      return { response: { version: 0.6, elements: [element, ...streets(200, 2)] }, tags };
    }],
    ["one node with tags over the limit", () => {
      const tags = { amenity: "bench", inscription: "x".repeat(70000) };
      return { response: { version: 0.6, elements: [node(1, 13.3, 52.4, tags), ...Array.from({ length: 200 }, (_, i) => node(2 + i, 13.31, 52.41))] }, tags };
    }],
  ];

  /** The deliberately late control: the same response assembled without
   * the early decision, then refused by its serialized length. */
  function lateRefusal(response: unknown) {
    const preview = osmPreviewAnswer(response, PROMOTED, null, limits.renderCapFeatures, Number.MAX_SAFE_INTEGER, () => {});
    if (bytesOf(preview) > LIMIT) throw new Error("refused late");
    return preview;
  }

  it.each(cases)("%s: refused unassembled, while the late control is not", async (_name, make) => {
    const early = watching();
    const built = make(early);
    watchTags(built.tags, early);
    fetchOverpass.mockImplementation(async () => ({ response: built.response, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    await expect(previewOsm({ ql: "nwr; out geom;", name: "source" })).rejects.toMatchObject({ code: "render_bytes_exceeded", message: expect.stringMatching(SENTENCE) });
    expect(early).toMatchObject({ coordinates: 0, tags: 0 });
    expect(assembled.features).toBe(0);
    vi.restoreAllMocks();

    const late = watching();
    const control = make(late);
    watchTags(control.tags, late);
    expect(() => lateRefusal(control.response)).toThrow("refused late");
    expect(late.tags).toBeGreaterThan(0);
    if (_name !== "one node with tags over the limit") expect(late.coordinates).toBeGreaterThanOrEqual(100000);
  });

  it("admits an element whose bound is just under the limit at exactly its size", () => {
    // Every pair is as short as a pair can be, so the bound is within the
    // feature's own members of its size.
    const minimal = Array.from({ length: 50000 }, (_, i): [number, number] => [i % 2, 0]);
    const response = { version: 0.6, elements: [way(1, minimal, { highway: "primary" })] };
    const before = previous(response, null, limits.renderCapFeatures);
    const limit = bytesOf(before);
    expect(limit - (6 * 50000 - 1)).toBeLessThan(400);
    expect(answer(response, null, limits.renderCapFeatures, limit)).toEqual(before);
    expect(() => answer(response, null, limits.renderCapFeatures, limit - 1)).toThrow(SENTENCE);
  });

  it("answers as before when the area leaves the oversized element out", () => {
    const response = { version: 0.6, elements: [way(1, long(50000), { highway: "primary" }), ...streets(3, 2)] };
    const area: WithinShape = { bbox: [13.29, 52.39, 13.32, 52.42] };
    const before = previous(response, area, limits.renderCapFeatures);
    expect(before.featureCount).toBe(3);
    expect(answer(response, area, limits.renderCapFeatures, LIMIT)).toEqual(before);
  });

  it("answers as before when later lines push the oversized polygon out", () => {
    const forest = { type: "relation", id: 9, tags: { type: "multipolygon", landuse: "forest", name: "Wood" }, members: [{ type: "way", ref: 90, role: "outer", geometry: path(ring(13.3, 52.4, 0.05, 50000)) }] };
    const response = { version: 0.6, elements: [forest, ...streets(2, 2)] };
    const before = previous(response, null, 2);
    expect(before).toMatchObject({ featureCount: 2, truncated: true });
    expect(answer(response, null, 2, LIMIT)).toEqual(before);
    expect(() => answer(response, null, 3, LIMIT)).toThrow(SENTENCE);
  });
});

/**
 * A relation counts against the limit only when the assembler makes a
 * feature of it: an outer ring of fewer than four nodes is discarded, and
 * a relation left without a ring makes none, however large its tags.
 */
describe("a multipolygon whose rings the assembler discards", () => {
  const LIMIT = 65_536;
  const forest = (members: Element[], note: string): Element =>
    ({ type: "relation", id: 9, tags: { type: "multipolygon", landuse: "forest", note }, members });
  const outer = (ref: number, geometry: unknown[]): Element => ({ type: "way", ref, role: "outer", geometry });

  it("answers the assembler's empty preview, not a refusal, when both outer rings have two nodes", () => {
    const response = { version: 0.6, elements: [forest([
      outer(1, path([[13.3, 52.4], [13.31, 52.41]])),
      outer(2, path([[13.32, 52.42], [13.33, 52.43]])),
    ], "x".repeat(70000))] };
    const before = previous(response, null, limits.renderCapFeatures);
    expect(before).toMatchObject({ featureCount: 0, truncated: false });
    expect(answer(response, null, limits.renderCapFeatures, LIMIT)).toEqual(before);
  });

  it("refuses before construction when the outer ways close a kept ring and the tags pass the limit", async () => {
    // Two outer ways that join into one ring of five nodes.
    const make = (seen: Watched) => {
      const relation = forest([
        outer(1, watchedPath([[13.3, 52.4], [13.31, 52.4], [13.31, 52.41]], seen)),
        outer(2, watchedPath([[13.31, 52.41], [13.3, 52.41], [13.3, 52.4]], seen)),
      ], "x".repeat(70000));
      return { response: { version: 0.6, elements: [relation] }, tags: relation.tags as object };
    };
    expect(classes(make(watching()).response)).toEqual([0, 0, 1]);
    const early = watching();
    const built = make(early);
    watchTags(built.tags, early);
    fetchOverpass.mockImplementation(async () => ({ response: built.response, fromCache: true }));
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    await expect(previewOsm({ ql: "nwr; out geom;", name: "source" })).rejects.toMatchObject({ code: "render_bytes_exceeded", message: expect.stringMatching(SENTENCE) });
    expect(early).toMatchObject({ coordinates: 0, tags: 0 });
    vi.restoreAllMocks();

    // The deliberately late control builds the ring and serializes the tags.
    const late = watching();
    const control = make(late);
    watchTags(control.tags, late);
    const preview = osmPreviewAnswer(control.response, PROMOTED, null, limits.renderCapFeatures, Number.MAX_SAFE_INTEGER, () => {});
    expect(bytesOf(preview)).toBeGreaterThan(LIMIT);
    expect(late.coordinates).toBeGreaterThan(0);
    expect(late.tags).toBeGreaterThan(0);
  });
});
