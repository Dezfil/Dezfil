import { afterEach, describe, expect, it, vi } from "vitest";
import { limits } from "@/lib/limits";
import { overpassResponse } from "@/lib/test-support/overpass-responses";
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

/** Features the assembler handed over, the largest geometry it built for
 * one and for each feature id, and whether it is running now, so that a
 * read of a raw coordinate can be told apart as construction. Every call
 * counts, the preview plan's own included: it asks the assembler whether
 * a closed way's tags make it a polygon by assembling a ring of three
 * nodes carrying them, one feature per closed way it measures, so a count
 * of features under a small limit includes those. */
const assembled = vi.hoisted(() => ({ features: 0, widest: 0, sizes: new Map<string, number>(), running: false }));
vi.mock("osmtogeojson", async (original) => {
  const real = (await original<{ default: (...args: unknown[]) => unknown }>()).default;
  return {
    default: (data: unknown, options: unknown, each?: (feature: unknown) => void) => {
      assembled.running = true;
      try {
        if (each) {
          return real(data, options, (feature: unknown) => {
            assembled.features++;
            const { id, geometry } = feature as { id?: unknown; geometry?: unknown };
            const size = Buffer.byteLength(JSON.stringify(geometry) ?? "", "utf8");
            assembled.widest = Math.max(assembled.widest, size);
            assembled.sizes.set(String(id), Math.max(assembled.sizes.get(String(id)) ?? 0, size));
            each(feature);
          });
        }
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
  assembled.widest = 0;
  assembled.sizes.clear();
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
  const nodes = points.map((_, i) => id * 1_000_000 + (closed && i === points.length - 1 ? 0 : i));
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
 * serialization of its tags; and on what the assembler hands over, the
 * largest geometry it built for one feature.
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

const LIMIT = 65_536;
const long = (n: number) => Array.from({ length: n }, (_, i): [number, number] => [13.3 + i * 1e-6, 52.4 + (i % 2) * 1e-4]);
/** Coordinates as OpenStreetMap stores them, to seven decimals. */
const precise = (n: number) => Array.from({ length: n }, (_, i): [number, number] =>
  [Math.round((13.4049538 + i * 0.0000123) * 1e7) / 1e7, Math.round((52.5200066 + (i % 7) * 0.0000037) * 1e7) / 1e7]);
const streets = (n: number, first: number) => Array.from({ length: n }, (_, i) => way(first + i, [[13.3, 52.4], [13.31, 52.41]], { highway: "service" }));
/** Twelve thousand control characters, seven bytes each in the answer. */
const CONTROL = "\u0001".repeat(12000);

/** The preview route's answer for a response under the byte limit. */
async function preview(response: unknown, cap?: number) {
  fetchOverpass.mockImplementation(async () => ({ response, fromCache: true }));
  process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
  if (cap !== undefined) process.env.DEZFIL_RENDER_CAP_FEATURES = String(cap);
  return previewOsm({ ql: "nwr; out geom;", name: "source" });
}

/** The deliberately late control: the same response assembled under no
 * limit, then refused by its serialized length. */
function lateRefusal(response: unknown, cap: number = limits.renderCapFeatures) {
  const preview = osmPreviewAnswer(response, PROMOTED, null, cap, Number.MAX_SAFE_INTEGER, () => {});
  if (bytesOf(preview) > LIMIT) throw new Error("refused late");
  return preview;
}

interface Made { response: { version: number; elements: Element[] }; tags: object; vertices: number; cap?: number }

/**
 * One element too large for the answer on its own is never assembled:
 * the assembler reads none of its coordinates and builds no geometry the
 * size of the limit, and its tags are never serialized. It is measured
 * from the raw response, each coordinate read once.
 */
describe("an element too large on its own is refused without being assembled", () => {
  const cases: [string, (seen: Watched) => Made][] = [
    ["one 50,000-vertex way", (seen) => {
      const tags = { highway: "primary" };
      const element = { ...way(1, long(50000), tags), geometry: watchedPath(long(50000), seen) };
      return { response: { version: 0.6, elements: [element, ...streets(20000, 2)] }, tags, vertices: 50000 };
    }],
    ["one multipolygon with a 50,000-vertex ring", (seen) => {
      const tags = { type: "multipolygon", landuse: "forest", name: "Wood" };
      const element = { type: "relation", id: 9, tags, members: [{ type: "way", ref: 90, role: "outer", geometry: watchedPath(ring(13.3, 52.4, 0.05, 50000), seen) }] };
      return { response: { version: 0.6, elements: [element, ...streets(200, 2)] }, tags, vertices: 50001 };
    }],
    ["one node with tags over the limit", () => {
      const tags = { amenity: "bench", inscription: "x".repeat(70000) };
      return { response: { version: 0.6, elements: [node(1, 13.3, 52.4, tags), ...Array.from({ length: 200 }, (_, i) => node(2 + i, 13.31, 52.41))] }, tags, vertices: 0 };
    }],
    ["one 5,000-vertex way at the precision OpenStreetMap stores", (seen) => {
      const tags = { highway: "primary" };
      const element = { ...way(1, precise(5000), tags), geometry: watchedPath(precise(5000), seen) };
      return { response: { version: 0.6, elements: [element, ...streets(20, 2)] }, tags, vertices: 5000 };
    }],
    ["one way tagged with 12,000 control characters", (seen) => {
      const tags = { highway: "service", note: CONTROL };
      const points: [number, number][] = [[13.3, 52.4], [13.31, 52.41]];
      const element = { ...way(1, points, tags), geometry: watchedPath(points, seen) };
      return { response: { version: 0.6, elements: [element, ...streets(20, 2)] }, tags, vertices: 2 };
    }],
    ["one node tagged with 12,000 control characters", () => {
      const tags = { amenity: "bench", note: CONTROL };
      return { response: { version: 0.6, elements: [node(1, 13.3, 52.4, tags), node(2, 13.31, 52.41)] }, tags, vertices: 0 };
    }],
    ["the first of two ways under a cap of one", (seen) => {
      const tags = { highway: "primary" };
      const element = { ...way(1, precise(5000), tags), geometry: watchedPath(precise(5000), seen) };
      return { response: { version: 0.6, elements: [element, ...streets(1, 2)] }, tags, vertices: 5000, cap: 1 };
    }],
  ];

  it.each(cases)("%s: refused unassembled, while the late control is not", async (_name, make) => {
    const early = watching();
    const built = make(early);
    watchTags(built.tags, early);
    await expect(preview(built.response, built.cap)).rejects.toMatchObject({ code: "render_bytes_exceeded", message: expect.stringMatching(SENTENCE) });
    expect(early).toMatchObject({ coordinates: 0, tags: 0 });
    expect(early.measured).toBeLessThanOrEqual(2 * built.vertices);
    expect(assembled.widest).toBeLessThan(LIMIT);
    vi.restoreAllMocks();

    const late = watching();
    const control = make(late);
    watchTags(control.tags, late);
    expect(() => lateRefusal(control.response, control.cap)).toThrow("refused late");
    expect(late.tags).toBeGreaterThan(0);
    expect(late.coordinates).toBeGreaterThanOrEqual(2 * control.vertices);
  });

  it("admits an element at exactly its size, and refuses it unassembled one byte under", () => {
    // Under a cap of one with a street after it, the answer is the way
    // alone and truncated: its smallest envelope.
    const points = precise(3000);
    const tags = { highway: "primary", name: "Quote \" backslash \\ tab \t", note: CONTROL.slice(0, 2000) };
    const make = (seen: Watched) => ({ version: 0.6, elements: [{ ...way(1, points, tags), geometry: watchedPath(points, seen) }, ...streets(1, 2)] });
    const before = previous(make(watching()), null, 1);
    expect(before).toMatchObject({ featureCount: 1, truncated: true });
    const limit = bytesOf(before);
    expect(limit).toBeGreaterThan(LIMIT);
    const at = watching();
    expect(osmPreviewAnswer(make(at), PROMOTED, null, 1, limit, () => {})).toEqual(before);
    expect(at.coordinates).toBeGreaterThanOrEqual(2 * 3000);

    const under = watching();
    watchTags(tags, under);
    expect(() => osmPreviewAnswer(make(under), PROMOTED, null, 1, limit - 1, () => {})).toThrow(SENTENCE);
    expect(under).toMatchObject({ coordinates: 0, tags: 0 });
    expect(under.measured).toBeLessThanOrEqual(2 * 3000);
  });

  it("answers as before, without assembling it, when the area leaves the oversized element out", () => {
    const make = (seen: Watched) => ({ version: 0.6, elements: [{ ...way(1, long(50000), { highway: "primary" }), geometry: watchedPath(long(50000), seen) }, ...streets(3, 2)] });
    const area: WithinShape = { bbox: [13.29, 52.39, 13.32, 52.42] };
    const before = previous(make(watching()), area, limits.renderCapFeatures);
    expect(before.featureCount).toBe(3);
    const seen = watching();
    expect(osmPreviewAnswer(make(seen), PROMOTED, area, limits.renderCapFeatures, LIMIT, () => {})).toEqual(before);
    expect(seen.coordinates).toBe(0);
    expect(assembled.widest).toBeLessThan(LIMIT);
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
 * An element too large for the answer that the cap leaves out does not
 * refuse the preview and is never assembled: the answer is byte for byte
 * the one the whole response gives.
 */
describe("an element too large on its own beyond the cap", () => {
  const short = (id: number) => way(id, [[13.3, 52.4], [13.31, 52.41]], { highway: "service" });
  const cases: [string, number, (seen: Watched) => Made][] = [
    ["a way after the line that fills a cap of one", 1, (seen) => {
      const tags = { highway: "primary", note: CONTROL };
      const element = { ...way(1, precise(5000), tags), geometry: watchedPath(precise(5000), seen) };
      return { response: { version: 0.6, elements: [short(2), element] }, tags, vertices: 5000 };
    }],
    ["a multipolygon after the point and the line that fill a cap of two", 2, (seen) => {
      const tags = { type: "multipolygon", landuse: "forest", name: "Wood" };
      const element = { type: "relation", id: 9, tags, members: [{ type: "way", ref: 90, role: "outer", geometry: watchedPath(ring(13.3, 52.4, 0.05, 50000), seen) }] };
      return { response: { version: 0.6, elements: [node(1, 13.3, 52.4), element, short(2)] }, tags, vertices: 50001 };
    }],
    ["a building after the line that fills a cap of one", 1, (seen) => {
      const tags = { building: "yes", name: "Hall" };
      const points = ring(13.3, 52.4, 0.01, 5000);
      const element = { ...way(1, points, tags), geometry: watchedPath(points, seen) };
      return { response: { version: 0.6, elements: [short(2), element] }, tags, vertices: 5001 };
    }],
    ["a node after the point that fills a cap of one", 1, () => {
      const tags = { amenity: "bench", note: CONTROL };
      return { response: { version: 0.6, elements: [node(1, 13.3, 52.4), node(2, 13.31, 52.41, tags)] }, tags, vertices: 0 };
    }],
  ];

  it.each(cases)("%s: admitted, never assembled, and the answer it gave before", (_name, cap, make) => {
    const before = previous(make(watching()).response, null, cap);
    expect(before.truncated).toBe(true);
    const seen = watching();
    const built = make(seen);
    watchTags(built.tags, seen);
    const answered = osmPreviewAnswer(built.response, PROMOTED, null, cap, LIMIT, () => {});
    expect(JSON.stringify(answered)).toBe(JSON.stringify(before));
    expect(seen).toMatchObject({ coordinates: 0, tags: 0 });
    expect(assembled.widest).toBeLessThan(LIMIT);
  });
});

/**
 * A relation counts against the limit only when the assembler makes a
 * feature of it: an outer ring of fewer than four nodes is discarded, and
 * a relation left without a ring makes none, however large its tags.
 */
describe("a multipolygon whose rings the assembler discards", () => {
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
    await expect(preview(built.response)).rejects.toMatchObject({ code: "render_bytes_exceeded", message: expect.stringMatching(SENTENCE) });
    expect(early).toMatchObject({ coordinates: 0, tags: 0 });
    vi.restoreAllMocks();

    // The deliberately late control builds the ring and serializes the tags.
    const late = watching();
    const control = make(late);
    watchTags(control.tags, late);
    const preview_ = osmPreviewAnswer(control.response, PROMOTED, null, limits.renderCapFeatures, Number.MAX_SAFE_INTEGER, () => {});
    expect(bytesOf(preview_)).toBeGreaterThan(LIMIT);
    expect(late.coordinates).toBeGreaterThan(0);
    expect(late.tags).toBeGreaterThan(0);
  });
});

/**
 * Over responses of every shape Overpass writes, at every cap and at
 * limits at and around the sizes of the answer and of single features,
 * the preview answers what the whole response answers, or refuses it
 * whole exactly when that answer is over the limit; and the assembler
 * builds no geometry larger than the answer has room for.
 */
describe("an OpenStreetMap preview of responses of every shape", () => {
  const envelope = (cap: number) => Math.min(...[false, true].map((truncated) =>
    Buffer.byteLength(JSON.stringify({ geojson: { type: "FeatureCollection", features: [] }, featureCount: 0, truncated, cap }), "utf8")));

  it.each(Array.from({ length: 24 }, (_, i) => i + 1))("answers what the whole response answers, building nothing too large: response %i", (seed) => {
    const response = overpassResponse(seed);
    for (const within of [null, { bbox: [13.4, 52.4, 13.5, 52.6] } as WithinShape]) {
      const all = previous(response, within, Number.MAX_SAFE_INTEGER);
      const sizes = all.geojson.features.map((feature) => Buffer.byteLength(JSON.stringify(feature), "utf8")).sort((a, b) => a - b);
      const picked = [sizes[0], sizes[Math.floor(sizes.length / 2)], sizes[sizes.length - 1]].filter((size) => size !== undefined);
      for (const cap of [...new Set([0, 1, 3, Math.floor(all.featureCount / 2), all.featureCount, limits.renderCapFeatures])]) {
        const before = previous(response, within, cap);
        const exact = bytesOf(before);
        const room = (limit: number) => limit - envelope(cap);
        for (const limit of [exact, exact - 1, ...picked.flatMap((size) => [size + envelope(cap), size + envelope(cap) - 1])]) {
          const where = `${within ? "an area" : "no area"}, cap ${cap}, limit ${limit}`;
          assembled.widest = 0;
          if (exact <= limit) expect(answer(response, within, cap, limit), where).toEqual(before);
          else expect(() => answer(response, within, cap, limit), where).toThrow(SENTENCE);
          expect(assembled.widest, where).toBeLessThanOrEqual(Math.max(room(limit), 1024));
        }
      }
    }
  });
});

/**
 * A way too large on its own that a relation the preview assembles whole
 * also reads by reference is still assembled small: the relation reads a
 * whole copy of it, and the answers are the ones the whole response gives.
 */
describe("an oversized way that a relation assembled whole also reads", () => {
  // An area with a hole. The way runs around the hole, every node of it in
  // the area; the relation's inner ring lies in the hole, so whether the
  // relation lies in the area turns on its inner ring, and it is assembled
  // whole.
  const AREA: WithinShape = { parts: [{
    outer: [[13.2, 52.3], [13.6, 52.3], [13.6, 52.7], [13.2, 52.7], [13.2, 52.3]],
    holes: [[[13.39, 52.49], [13.41, 52.49], [13.41, 52.51], [13.39, 52.51], [13.39, 52.49]]],
  }] };
  const around = (n: number, size: number) => ring(13.4, 52.5, size, n).slice(0, -1)
    .map(([lon, lat]): [number, number] => [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]);
  const make = (seen: Watched) => {
    const points = around(5000, 0.05);
    const tags = { highway: "primary", name: "Ring road" };
    const road = { type: "way", id: 1, nodes: points.map((_, i) => 1000 + i), geometry: watchedPath(points, seen), tags };
    const wood = { type: "relation", id: 9, tags: { type: "multipolygon", landuse: "forest", name: "Wood" }, members: [
      { type: "way", ref: 1, role: "outer" },
      { type: "way", ref: 2, role: "inner", geometry: path([...around(6, 0.005), around(6, 0.005)[0]]) },
    ] };
    return { response: { version: 0.6, elements: [road, wood] }, tags };
  };

  it.each([
    ["in the answer", limits.renderCapFeatures],
    ["beyond a cap of none", 0],
  ])("%s: the way's own line is assembled small and the answer is the one before", (_name, cap) => {
    const before = previous(make(watching()).response, AREA, cap);
    const seen = watching();
    const built = make(seen);
    watchTags(built.tags, seen);
    const run = () => osmPreviewAnswer(built.response, PROMOTED, AREA, cap, LIMIT, () => {});
    if (bytesOf(before) > LIMIT) expect(run).toThrow(SENTENCE);
    else expect(JSON.stringify(run())).toBe(JSON.stringify(before));
    // The relation, assembled whole, reads each coordinate once; the way's
    // own line is built from a few nodes, and its tags never serialized.
    expect(assembled.sizes.get("way/1")).toBeLessThanOrEqual(1024);
    expect(assembled.sizes.get("relation/9")).toBeGreaterThan(LIMIT);
    expect(seen.coordinates).toBeLessThanOrEqual(2 * 5000);
    expect(seen.tags).toBe(0);
  });

  /** A building whose tags pass the limit, the outer way by reference of
   * a multipolygon that fits, given with its geometry or by node elements
   * that follow it. */
  const building = (skeleton: boolean): Element[] => {
    const points = around(12, 0.002);
    const ids = [...points.map((_, i) => 5000 + i), 5000];
    const tags = { building: "yes", note: "x".repeat(70000) };
    const hall: Element = { type: "way", id: 1, nodes: ids, tags };
    if (!skeleton) hall.geometry = path([...points, points[0]]);
    const yard = { type: "relation", id: 9, tags: { type: "multipolygon", landuse: "grass", name: "Yard" }, members: [{ type: "way", ref: 1, role: "outer" }] };
    const nodes = skeleton ? points.map(([lon, lat], i) => ({ type: "node", id: 5000 + i, lat, lon })) : [];
    return [hall, yard, ...nodes];
  };

  it.each([["with its geometry", false], ["by node elements", true]])("a multipolygon that fits reads a whole copy of an oversized building given %s", (_name, skeleton) => {
    const response = { version: 0.6, elements: building(skeleton as boolean) };
    // The multipolygon comes first and fills a cap of one; the building is
    // left out.
    const before = previous(response, null, 1);
    expect(before).toMatchObject({ featureCount: 1, truncated: true });
    expect(JSON.stringify(answer(response, null, 1, LIMIT))).toBe(JSON.stringify(before));
    expect(() => answer(response, null, 2, LIMIT)).toThrow(SENTENCE);
  });
});
