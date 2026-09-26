import { describe, expect, it, vi } from "vitest";
import {
  cachedLabelFeatures,
  createLabelStore,
  labelShape,
  labelableFeatures,
  type LabelBases,
} from "./label-data";
import type { LabelStyle } from "@/lib/style/style";

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

const style = (over: Partial<LabelStyle> = {}): LabelStyle => ({
  attribute: "name",
  size: 12,
  color: WHITE,
  haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
  ...over,
});

const point = (
  properties: Record<string, unknown>,
  coordinates: [number, number] = [7, 51],
) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates } });

const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });

/** The label text actually kept, so a test can assert content, not shape. */
const labelNames = (kept: unknown[]) =>
  (kept as { properties: { name: string } }[]).map((f) => f.properties.name);

/**
 * The membership rules as they behave today (` `). Written before the reuse
 * landed on top of them, so a difference shows up here rather than as a
 * subtly different map.
 */
describe("labelableFeatures — membership", () => {
  it("keeps a feature with both text and a position", () => {
    const kept = labelableFeatures(fc([point({ name: "Köln" })]), style());
    expect(kept).toHaveLength(1);
  });

  it("drops a feature whose labelled attribute is missing, null or empty", () => {
    const features = [
      point({ other: "x" }),
      point({ name: null }),
      point({ name: "" }),
    ];
    expect(labelableFeatures(fc(features), style())).toHaveLength(0);
  });

  it("keeps a numeric zero — falsy, but a real value to label", () => {
    const kept = labelableFeatures(fc([point({ name: 0 })]), style());
    expect(kept).toHaveLength(1);
  });

  it("drops a feature with no position: no anchor and no point geometry", () => {
    const noGeometry = { type: "Feature", properties: { name: "x" }, geometry: null };
    const polygonNoAnchor = {
      type: "Feature",
      properties: { name: "x" },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
    expect(labelableFeatures(fc([noGeometry, polygonNoAnchor]), style())).toHaveLength(0);
  });

  it("keeps a polygon that carries the server-computed anchor", () => {
    const withAnchor = {
      type: "Feature",
      properties: { name: "x", __anchor: [7, 51] },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
    expect(labelableFeatures(fc([withAnchor]), style())).toHaveLength(1);
  });

  it("labels aggregated cells off `value` when no attribute is set", () => {
    const cells = fc([point({ value: 42 }), point({ value: null })]);
    expect(labelableFeatures(cells, style({ attribute: undefined }))).toHaveLength(1);
  });

  it("survives a null, empty or feature-less input rather than throwing", () => {
    expect(labelableFeatures(null, style())).toEqual([]);
    expect(labelableFeatures({}, style())).toEqual([]);
    expect(labelableFeatures(fc([]), style())).toEqual([]);
  });

  it("filters rather than reorders — kept features hold their input order", () => {
    const features = [
      point({ name: "a" }),
      point({ name: null }),
      point({ name: "b" }),
    ];
    const kept = labelableFeatures(fc(features), style()) as {
      properties: { name: string };
    }[];
    expect(kept.map((f) => f.properties.name)).toEqual(["a", "b"]);
  });
});

/**
 * The reuse contract (` `). Identity is what is asserted, not equality:
 * deck.gl keys `data` by identity, so an equal-but-fresh array is exactly
 * the defect. Every input that must invalidate gets its own case rather than
 * one blanket test — a stale label is a worse defect than a slow one, so
 * each rule is held separately.
 */
describe("cachedLabelFeatures — reuse and invalidation", () => {
  const data = fc([point({ name: "Köln" }), point({ name: "Bonn" })]);

  it("returns the very same array when nothing it depends on changed", () => {
    const bases: LabelBases = {};
    const first = cachedLabelFeatures(bases, "layer-1", data, style());
    const second = cachedLabelFeatures(bases, "layer-1", data, style());
    expect(second).toBe(first);
  });

  it("does not re-derive for a style change that cannot alter membership", () => {
    const bases: LabelBases = {};
    const first = cachedLabelFeatures(bases, "layer-1", data, style({ size: 12 }));
    const bigger = cachedLabelFeatures(bases, "layer-1", data, style({ size: 40 }));
    const haloed = cachedLabelFeatures(bases, "layer-1", data, style({ haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } }));
    const recoloured = cachedLabelFeatures(
      bases,
      "layer-1",
      data,
      style({ color: BLACK }),
    );
    // The regression guard for these are the ticks a slider drag makes.
    expect(bigger).toBe(first);
    expect(haloed).toBe(first);
    expect(recoloured).toBe(first);
  });

  it("re-derives when the labelled attribute changes", () => {
    const bases: LabelBases = {};
    const byName = cachedLabelFeatures(bases, "layer-1", data, style());
    const byOther = cachedLabelFeatures(
      bases,
      "layer-1",
      data,
      style({ attribute: "other" }),
    );
    expect(byOther).not.toBe(byName);
  });

  it("re-derives when the layer's feature data changes", () => {
    const bases: LabelBases = {};
    const first = cachedLabelFeatures(bases, "layer-1", data, style());
    // Different content, not just a different wrapper: a refresh that
    // renamed one feature and dropped the other's label must be visible in
    // what comes back. Asserting only identity and length would pass for an
    // implementation that wrapped the stale features in a new array.
    const refreshed = fc([point({ name: "Aachen" }), point({ name: null })]);
    const second = labelNames(
      cachedLabelFeatures(bases, "layer-1", refreshed, style()),
    );
    expect(labelNames(first)).toEqual(["Köln", "Bonn"]);
    expect(second).toEqual(["Aachen"]);
  });

  it("re-derives when the attribute goes to and from the aggregated fallback", () => {
    const cells = fc([point({ value: 1, name: "a" })]);
    const bases: LabelBases = {};
    const byAttribute = cachedLabelFeatures(bases, "layer-1", cells, style());
    const byValue = cachedLabelFeatures(
      bases,
      "layer-1",
      cells,
      style({ attribute: undefined }),
    );
    expect(byValue).not.toBe(byAttribute);
  });

  it("keeps layers apart — one layer's data never serves another", () => {
    const bases: LabelBases = {};
    const other = fc([point({ name: "Aachen" })]);
    const first = cachedLabelFeatures(bases, "layer-1", data, style());
    const second = cachedLabelFeatures(bases, "layer-2", other, style());
    expect(second).not.toBe(first);
    expect(cachedLabelFeatures(bases, "layer-1", data, style())).toBe(first);
  });

});

/**
 * The reclaim, driven through the real store rather than by deleting from
 * the record by hand — a hand-deleting test passes even if `retain` becomes
 * a no-op, which is the whole thing it is supposed to catch.
 *
 * Retention is asserted through `read` identity, because that is what the
 * canvas actually observes: a kept layer keeps serving the same array, and a
 * dropped one derives a new one.
 */
describe("createLabelStore — sweep", () => {
  const data = fc([point({ name: "Köln" }), point({ name: "Bonn" })]);
  const layer = (id: string) => ({ id, geojson: data });

  it("skips cache enumeration when there is nothing to sweep", () => {
    const store = createLabelStore();
    const keys = vi.spyOn(Object, "keys");
    try {
      store.sweep();
      expect.soft(keys).not.toHaveBeenCalled();

      store.read(layer("layer-1"), style());
      store.sweep();
      store.sweep(); // The last entry leaves.
      keys.mockClear();
      store.sweep();
      expect(keys).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore();
    }
  });

  it("keeps what the build read", () => {
    const store = createLabelStore();
    const one = store.read(layer("layer-1"), style());
    const two = store.read(layer("layer-2"), style());

    store.sweep();

    expect(store.read(layer("layer-1"), style())).toBe(one);
    expect(store.read(layer("layer-2"), style())).toBe(two);
  });

  it("drops what the build did not read", () => {
    const store = createLabelStore();
    const one = store.read(layer("layer-1"), style());
    const two = store.read(layer("layer-2"), style());
    store.sweep();

    // The next build reads only layer-1 — layer-2 went to a road with no
    // inline labels (heatmap, cluster), was hidden, or left the map. The
    // store does not need to know which: it was not asked for.
    store.read(layer("layer-1"), style());
    store.sweep();

    expect(store.read(layer("layer-1"), style())).toBe(one);
    expect(store.read(layer("layer-2"), style())).not.toBe(two);
  });

  it("drops everything when a build reads nothing", () => {
    const store = createLabelStore();
    const before = store.read(layer("layer-1"), style());
    store.sweep();

    store.sweep();

    expect(store.read(layer("layer-1"), style())).not.toBe(before);
  });

  it("does not drop on the sweep that follows the read", () => {
    // Ordering guard: sweep runs AFTER the build, so a layer read in this
    // build must survive this build's sweep. Sweeping before the build
    // would evict everything, every time, and the reuse would do nothing.
    const store = createLabelStore();
    const first = store.read(layer("layer-1"), style());
    store.sweep();
    expect(store.read(layer("layer-1"), style())).toBe(first);
  });
});

describe("labelShape — the signature", () => {
  it("collapses the three ways of saying 'label off value'", () => {
    expect(labelShape(style({ attribute: undefined }))).toBe("");
    expect(labelShape(style({ attribute: null as unknown as undefined }))).toBe("");
    expect(labelShape(style({ attribute: "" }))).toBe("");
  });

  it("separates distinct attributes", () => {
    expect(labelShape(style({ attribute: "a" }))).not.toBe(
      labelShape(style({ attribute: "b" })),
    );
  });

  it("ignores everything that only changes how a label looks", () => {
    const base = labelShape(style());
    expect(labelShape(style({ size: 40 }))).toBe(base);
    expect(labelShape(style({ haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } }))).toBe(base);
    expect(labelShape(style({ color: BLACK }))).toBe(base);
  });
});
