import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({
  ...await original<object>(),
  ...(await import("../workflow-canvas/hook-harness")).hookReact,
}));
import { HookHarness } from "../workflow-canvas/hook-harness";
import { MapCanvas, type RenderedLayer } from "./MapCanvas";
import type { LabelBases } from "./label-data";
import type { LiveDim } from "@/lib/live-filters";
import type { LabelCount } from "../builder/style-panel/LabelSection";

const color = { r: 255, g: 255, b: 255, a: 1 };
const target: RenderedLayer = {
  id: "removed-labelled-layer",
  visible: true,
  style: {
    fill: { type: "constant", color },
    fillOpacity: 1,
    stroke: color,
    strokeOpacity: 1,
    strokeWidth: 1,
    pointRadius: 3,
    opacity: 1,
    label: { attribute: "name", size: 12, color, haloWidth: 0, haloColor: color },
  },
  geojson: {
    type: "FeatureCollection",
    features: [0, 1].map((riders) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [13.2 + riders * 0.0004, 52.4] },
      properties: { name: `Point ${riders}`, riders },
    })),
  },
};
const remaining: RenderedLayer = {
  ...target,
  id: "remaining-unlabelled-layer",
  style: { ...target.style, label: undefined },
  geojson: { type: "FeatureCollection", features: [] },
};

afterEach(() => vi.restoreAllMocks());

describe("canvas label-store lifetime", () => {
  it("releases the removed id on removal after a settled live-filter build, before a further style edit", () => {
    // Observe the real store's record as its sweep enumerates it. Do not
    // replace the store, predict membership, or probe with read: read itself
    // marks an entry touched and would change the ordering under test.
    let bases: LabelBases | undefined;
    const keys = Object.keys;
    vi.spyOn(Object, "keys").mockImplementation((object) => {
      if ((object as LabelBases)[target.id]?.key === target.geojson) {
        bases = object as LabelBases;
      }
      return keys(object);
    });
    let layers = [remaining, target];
    let liveFilters: Record<string, LiveDim[]> = {};
    const counts = vi.fn<(value: Record<string, LabelCount | null>) => void>();
    // Runs MapCanvas's actual builds/effects and label preparation. No DOM
    // ref is attached, so this does not start MapLibre or claim heap evidence.
    const canvas = new HookHarness(() => MapCanvas({
      layers, liveFilters, onLabelCounts: counts,
      basemapUrl: "", initialViewport: { lng: 13.2, lat: 52.4, zoom: 0 },
    }));
    try {
      expect(bases).toBeDefined();
      expect(bases![target.id].key).toBe(target.geojson);
      const derived = bases![target.id].features;
      expect(derived).toHaveLength(2);
      expect(counts.mock.lastCall?.[0][target.id]).toMatchObject({ shown: 2, total: 2 });

      counts.mockClear();
      liveFilters = { [target.id]: [{ kind: "range", field: "riders", range: [0, 0] }] };
      canvas.render();
      expect(counts).toHaveBeenCalledOnce();
      expect(counts.mock.lastCall?.[0][target.id]).toMatchObject({ shown: 1, total: 1 });
      expect(bases![target.id].features).toBe(derived);

      // Keep the settled filter prop stable: only the removal's layers
      // change runs. Neither layer is a cluster or has a label zoom floor,
      // so the integer-zoom effect never builds in this case.
      layers = [remaining];
      canvas.render();
      expect(counts.mock.lastCall?.[0]).toEqual({});
      expect.soft(Object.hasOwn(bases!, target.id)).toBe(false);

      layers = [{ ...remaining, style: { ...remaining.style, opacity: 0.9 } }];
      canvas.render();
      expect(Object.hasOwn(bases!, target.id)).toBe(false);
    } finally {
      canvas.unmount();
    }
  });

  it("releases the removed id after the integer-zoom build at mount, without a filter step", () => {
    const flooredTarget: RenderedLayer = {
      ...target,
      style: { ...target.style, label: { ...target.style.label!, zoomFloor: 5 } },
    };
    let bases: LabelBases | undefined;
    const keys = Object.keys;
    vi.spyOn(Object, "keys").mockImplementation((object) => {
      if ((object as LabelBases)[target.id]?.key === target.geojson) {
        bases = object as LabelBases;
      }
      return keys(object);
    });
    let layers = [remaining, flooredTarget];
    // The floor admits the integer-zoom effect at mount even without a map
    // instance. Assert the store: zoom 0 gates the displayed label count.
    const canvas = new HookHarness(() => MapCanvas({
      layers,
      basemapUrl: "", initialViewport: { lng: 13.2, lat: 52.4, zoom: 0 },
    }));
    try {
      expect(bases).toBeDefined();
      expect(bases![target.id].key).toBe(target.geojson);
      expect(bases![target.id].features).toHaveLength(2);

      layers = [remaining];
      canvas.render();
      expect.soft(Object.hasOwn(bases!, target.id)).toBe(false);

      layers = [{ ...remaining, style: { ...remaining.style, opacity: 0.9 } }];
      canvas.render();
      expect(Object.hasOwn(bases!, target.id)).toBe(false);
    } finally {
      canvas.unmount();
    }
  });
});
