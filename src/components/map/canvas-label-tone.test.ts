import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({
  ...await original<object>(),
  ...(await import("../workflow-canvas/hook-harness")).hookReact,
}));
// Whether the basemap's style failed and the canvas drew its plain
// background: only the lifecycle knows, and with no map here it is set by hand.
const lifecycle = vi.hoisted(() => ({ failed: false }));
vi.mock("./use-basemap-style", () => ({
  useBasemapStyle: () => ({ basemapFailed: lifecycle.failed, attach: () => {} }),
}));
// What the renderer is handed: each feature layer's label, and each tiled
// layer's tone.
const drawn = vi.hoisted(() => ({ labels: [] as unknown[], tiles: [] as unknown[] }));
vi.mock("./text-sublayer", async (original) => {
  const actual = await original<typeof import("./text-sublayer")>();
  return { ...actual, textSublayer: (...args: Parameters<typeof actual.textSublayer>) => {
    drawn.labels.push(args[2]);
    return actual.textSublayer(...args);
  } };
});
vi.mock("./tiled-layer", async (original) => {
  const actual = await original<typeof import("./tiled-layer")>();
  return { ...actual, createTiledLayer: (...args: Parameters<typeof actual.createTiledLayer>) => {
    drawn.tiles.push(args[1].labelTone);
    return actual.createTiledLayer(...args);
  } };
});
import { HookHarness } from "../workflow-canvas/hook-harness";
import { MapCanvas, type RenderedLayer } from "./MapCanvas";
import type { LabelStyle } from "@/lib/style/style";
import type { LabelSurface } from "./use-label-look";

/**
 * The canvas paints its labels for the tone of what it actually drew, and
 * tells its host that tone: the style's own, or the surface's theme where
 * the style could not load and the canvas drew its plain background. A
 * change of either repaints the labels in place, with no new map.
 */

const DARK_TEXT = { r: 0xe9, g: 0xec, b: 0xf3, a: 1 };
const LIGHT_TEXT = { r: 0x24, g: 0x32, b: 0x30, a: 1 };
const OWN = { r: 200, g: 40, b: 40, a: 0.5 };

const labelled = (label: Partial<LabelStyle>, tiled = false): RenderedLayer => ({
  id: tiled ? "tiled" : "towns",
  visible: true,
  style: {
    fill: { type: "constant", color: OWN }, fillOpacity: 1, stroke: OWN, strokeOpacity: 1, strokeWidth: 1, pointRadius: 3, opacity: 1,
    label: { attribute: "name", size: 12, color: LIGHT_TEXT, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 }, ...label },
  },
  geojson: tiled ? null : {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [13.2, 52.4] }, properties: { name: "Mitte" } }],
  },
  tiles: tiled ? { url: "/api/tiles/{z}/{x}/{y}.pbf" } : null,
});
const AUTOMATIC = labelled({ textPaint: "automatic", haloPaint: "automatic" });

afterEach(() => {
  lifecycle.failed = false;
  drawn.labels.length = 0;
  drawn.tiles.length = 0;
});

function mount(initial: { layers: RenderedLayer[]; labels: LabelSurface }) {
  const props = { ...initial };
  const reported: string[] = [];
  const canvas = new HookHarness(() => MapCanvas({
    layers: props.layers, labels: props.labels, onLabelTone: (tone) => reported.push(tone),
    basemapUrl: "", initialViewport: { lng: 13.2, lat: 52.4, zoom: 0 },
  }));
  return {
    props, reported, canvas,
    /** The tone the canvas marks itself painted for. */
    marked: () => (canvas.value as { props: Record<string, unknown> }).props["data-label-tone"],
    /** The paint of the last label the renderer was handed. */
    lastPaint: () => {
      const label = drawn.labels.at(-1) as LabelStyle;
      return { color: label.color, haloColor: label.haloColor, haloWidth: label.haloWidth };
    },
  };
}

describe("the canvas's labels and the tone it drew", () => {
  it("paints automatic labels for the style's tone and tells its host that tone", () => {
    const map = mount({ layers: [AUTOMATIC], labels: { face: "inter", tone: "dark", theme: "light" } });
    try {
      expect(map.lastPaint()).toEqual({ color: DARK_TEXT, haloColor: { r: 0x0b, g: 0x0e, b: 0x14, a: 1 }, haloWidth: 1.5 });
      expect(map.reported.at(-1)).toBe("dark");
      expect(map.marked()).toBe("dark");
    } finally {
      map.canvas.unmount();
    }
  });

  it("paints for the surface's theme, and says so, where the style failed and it drew its plain background", () => {
    lifecycle.failed = true;
    const map = mount({ layers: [AUTOMATIC], labels: { face: "inter", tone: "dark", theme: "light" } });
    try {
      expect(map.lastPaint().color).toEqual(LIGHT_TEXT);
      expect(map.reported.at(-1)).toBe("light");
      expect(map.marked()).toBe("light");
    } finally {
      map.canvas.unmount();
    }
  });

  it("repaints at once when the host's tone changes, a theme or basemap switch, on the same canvas", () => {
    const map = mount({ layers: [AUTOMATIC], labels: { face: "inter", tone: "light", theme: "light" } });
    try {
      expect(map.lastPaint().color).toEqual(LIGHT_TEXT);
      map.props.labels = { face: "inter", tone: "dark", theme: "dark" };
      map.canvas.render();
      expect(map.lastPaint().color).toEqual(DARK_TEXT);
      expect(map.reported).toEqual(["light", "dark"]);
    } finally {
      map.canvas.unmount();
    }
  });

  it("keeps a label of its own as it is over either tone", () => {
    const own = labelled({ textPaint: "own", haloPaint: "own", color: OWN, haloColor: OWN, haloWidth: 2 });
    const map = mount({ layers: [own], labels: { face: "inter", tone: "dark", theme: "dark" } });
    try {
      expect(map.lastPaint()).toEqual({ color: OWN, haloColor: OWN, haloWidth: 2 });
      map.props.labels = { face: "inter", tone: "light", theme: "light" };
      map.canvas.render();
      expect(map.lastPaint()).toEqual({ color: OWN, haloColor: OWN, haloWidth: 2 });
    } finally {
      map.canvas.unmount();
    }
  });

  it("hands a tiled layer the same tone, offline fallback included", () => {
    const tiled = labelled({ textPaint: "automatic", haloPaint: "automatic" }, true);
    const map = mount({ layers: [tiled], labels: { face: "inter", tone: "dark", theme: "light" } });
    try {
      expect(drawn.tiles.at(-1)).toBe("dark");
    } finally {
      map.canvas.unmount();
    }
    lifecycle.failed = true;
    const offline = mount({ layers: [tiled], labels: { face: "inter", tone: "dark", theme: "light" } });
    try {
      expect(drawn.tiles.at(-1)).toBe("light");
    } finally {
      offline.canvas.unmount();
    }
  });
});
