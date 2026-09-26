import { describe, it, expect } from "vitest";
import { effectiveExtent, featurePasses, mergeExtent } from "./map-extent";
import { numToRange, selectionDim, type LiveDim } from "./live-filters";

const point = (lng: number, lat: number, props: Record<string, unknown> = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: props,
});

const collection = (features: unknown[]) => ({ type: "FeatureCollection", features });

const layer = (over: Partial<Parameters<typeof effectiveExtent>[0][number]>) => ({
  id: "l1",
  visible: true,
  geojson: null,
  tiles: null,
  dims: [] as LiveDim[],
  ...over,
});

describe("the current effective extent", () => {
  it("frames every feature when nothing constrains the layer", () => {
    const extent = effectiveExtent([
      layer({ geojson: collection([point(0, 0), point(10, 20)]) }),
    ]);
    expect(extent.bounds).toEqual([
      [0, 0],
      [10, 20],
    ]);
    expect(extent.deferred).toEqual([]);
  });

  it("frames only the features a range constraint leaves drawn", () => {
    // The far point is filtered out on the canvas, not in the query — the
    // exact case that used to pull the camera back to frame nothing.
    const dims: LiveDim[] = [
      { field: "n", kind: "range", range: numToRange(null, 5) },
    ];
    const extent = effectiveExtent([
      layer({
        geojson: collection([point(0, 0, { n: 1 }), point(50, 50, { n: 99 })]),
        dims,
      }),
    ]);
    expect(extent.bounds).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("frames only the categories a widget selection leaves drawn", () => {
    // Since the named set is what is EXCLUDED.
    const extent = effectiveExtent([
      layer({
        geojson: collection([
          point(0, 0, { kind: "keep" }),
          point(40, 40, { kind: "drop" }),
        ]),
        dims: [selectionDim("kind", ["drop"])],
      }),
    ]);
    expect(extent.bounds).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("gives nothing when the constraints leave nothing drawn", () => {
    const extent = effectiveExtent([
      layer({
        geojson: collection([point(0, 0, { n: 99 })]),
        dims: [{ field: "n", kind: "range", range: numToRange(null, 5) }],
      }),
    ]);
    expect(extent.bounds).toBeNull();
    expect(extent.deferred).toEqual([]);
  });

  it("ignores a hidden layer", () => {
    const extent = effectiveExtent([
      layer({ id: "shown", geojson: collection([point(0, 0)]) }),
      layer({ id: "hidden", visible: false, geojson: collection([point(80, 80)]) }),
    ]);
    expect(extent.bounds).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("takes an unconstrained tiled layer's archive box", () => {
    const extent = effectiveExtent([layer({ tiles: [-5, -5, 5, 5] })]);
    expect(extent.bounds).toEqual([
      [-5, -5],
      [5, 5],
    ]);
    expect(extent.deferred).toEqual([]);
  });

  it("defers a CONSTRAINED tiled layer rather than guessing from its box", () => {
    // The archive's box reflects the query it was built from, never the
    // constraints the canvas applies afterwards — and the loaded tiles
    // follow the viewport, so an answer taken from them would depend on
    // where the reader happened to be looking.
    const extent = effectiveExtent([
      layer({
        id: "tiled",
        tiles: [-5, -5, 5, 5],
        dims: [{ field: "n", kind: "range", range: numToRange(null, 5) }],
      }),
    ]);
    expect(extent.bounds).toBeNull();
    expect(extent.deferred).toEqual(["tiled"]);
  });

  it("still answers for the inline layers beside a deferred tiled one", () => {
    const extent = effectiveExtent([
      layer({ id: "inline", geojson: collection([point(1, 2)]) }),
      layer({
        id: "tiled",
        tiles: [-50, -50, 50, 50],
        dims: [selectionDim("k", ["x"])],
      }),
    ]);
    expect(extent.bounds).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(extent.deferred).toEqual(["tiled"]);
  });

  it("gives a still-preparing tiled layer no extent, and does not defer it", () => {
    const extent = effectiveExtent([layer({ id: "building" })]);
    expect(extent.bounds).toBeNull();
    expect(extent.deferred).toEqual([]);
  });

  it("merges a server answer into the browser's", () => {
    expect(mergeExtent([[0, 0], [1, 1]], [-2, -2, 0, 0])).toEqual([
      [-2, -2],
      [1, 1],
    ]);
    expect(mergeExtent(null, [-2, -2, 0, 0])).toEqual([
      [-2, -2],
      [0, 0],
    ]);
    expect(mergeExtent([[0, 0], [1, 1]], null)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("featurePasses mirrors what the canvas draws", () => {
  it("is inclusive at both bounds, as the canvas comparison is", () => {
    const dim: LiveDim = { field: "n", kind: "range", range: numToRange(1, 3) };
    expect(featurePasses(point(0, 0, { n: 1 }), [dim])).toBe(true);
    expect(featurePasses(point(0, 0, { n: 3 }), [dim])).toBe(true);
    expect(featurePasses(point(0, 0, { n: 0.9 }), [dim])).toBe(false);
  });

  it("drops a null value under any real bound, as SQL does", () => {
    const dim: LiveDim = { field: "n", kind: "range", range: numToRange(1, null) };
    expect(featurePasses(point(0, 0, { n: null }), [dim])).toBe(false);
  });

  it("keeps a null value under a fully open filter, as SQL does", () => {
    const dim: LiveDim = {
      field: "n",
      kind: "range",
      range: numToRange(null, null),
    };
    expect(featurePasses(point(0, 0, { n: null }), [dim])).toBe(true);
  });

  it("requires every dimension, not any", () => {
    const dims: LiveDim[] = [
      { field: "a", kind: "range", range: numToRange(null, 5) },
      { field: "b", kind: "range", range: numToRange(10, null) },
    ];
    expect(featurePasses(point(0, 0, { a: 1, b: 20 }), dims)).toBe(true);
    expect(featurePasses(point(0, 0, { a: 1, b: 2 }), dims)).toBe(false);
  });
});
