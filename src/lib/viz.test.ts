import { describe, it, expect } from "vitest";
import {
  defaultViz,
  isValidViz,
  normalizeViz,
  vizAppearanceOnly,
  HEX_CELL_KM,
  POINTS_VIZ,
  type LayerViz,
} from "@/lib/viz";

const heat = defaultViz("heatmap") as Extract<LayerViz, { type: "heatmap" }>;
const hexbin = defaultViz("hexbin") as Extract<LayerViz, { type: "hexbin" }>;

describe("appearance-only viz edits", () => {
  it("heatmap radius/intensity/weight ticks never reshape the query", () => {
    expect(vizAppearanceOnly(heat, { ...heat, radiusPx: 60 })).toBe(true);
    expect(vizAppearanceOnly(heat, { ...heat, intensity: 3 })).toBe(true);
    expect(vizAppearanceOnly(heat, { ...heat, weight: "riders" })).toBe(true);
  });

  it("type changes and aggregated edits reshape the query", () => {
    expect(vizAppearanceOnly(heat, POINTS_VIZ)).toBe(false);
    expect(vizAppearanceOnly(POINTS_VIZ, heat)).toBe(false);
    expect(vizAppearanceOnly(hexbin, { ...hexbin, cellKm: 0.17 })).toBe(
      false,
    );
    expect(vizAppearanceOnly(hexbin, hexbin)).toBe(false);
  });
});

describe("continuous cell sizes", () => {
  it("hexbin accepts any cell size in range, not H3 steps", () => {
    for (const cellKm of [0.02, 0.8, 2.5, 999]) {
      expect(
        isValidViz({ type: "hexbin", cellKm, aggregate: { fn: "count" } }),
      ).toBe(true);
    }
    expect(
      isValidViz({ type: "hexbin", cellKm: 0.001, aggregate: { fn: "count" } }),
    ).toBe(false);
    expect(
      isValidViz({ type: "hexbin", resolution: 7, aggregate: { fn: "count" } }),
    ).toBe(false);
  });

  it("icon glyphs validate against the curated set", () => {
    expect(isValidViz({ type: "icon", glyph: "cafe" })).toBe(true);
    expect(isValidViz({ type: "icon", glyph: "not-a-glyph" })).toBe(false);
    // The custom field: nullable string beside the glyph; the glyph
    // stays validated regardless (clearing reveals it again).
    expect(
      isValidViz({ type: "icon", glyph: "cafe", customSvg: "<svg/>" }),
    ).toBe(true);
    expect(
      isValidViz({ type: "icon", glyph: "cafe", customSvg: null }),
    ).toBe(true);
    expect(
      isValidViz({ type: "icon", glyph: "cafe", customSvg: 42 }),
    ).toBe(false);
    expect(
      isValidViz({ type: "icon", glyph: "not-a-glyph", customSvg: "<svg/>" }),
    ).toBe(false);
    expect(isValidViz(defaultViz("icon"))).toBe(true);
  });

  it("cluster validates radius, color, and the counts toggle", () => {
    expect(isValidViz(defaultViz("cluster"))).toBe(true);
    expect(
      isValidViz({
        type: "cluster",
        radiusPx: 64,
        color: "fixed",
        showCounts: false,
      }),
    ).toBe(true);
    expect(
      isValidViz({
        type: "cluster",
        radiusPx: 64,
        color: { fn: "avg", attribute: "riders" },
        showCounts: true,
      }),
    ).toBe(true);
    expect(
      isValidViz({ type: "cluster", radiusPx: 4, color: "fixed", showCounts: true }),
    ).toBe(false);
    expect(
      isValidViz({ type: "cluster", radiusPx: 64, color: "chartreuse", showCounts: true }),
    ).toBe(false);
  });

  it("arc endpoint moves reshape the query; height and color do not", () => {
    const arc = {
      type: "arc",
      origin: { kind: "geometry", field: "a" },
      dest: { kind: "geometry", field: "b" },
      height: 0.6,
    } as Extract<LayerViz, { type: "arc" | "line" }>;
    expect(vizAppearanceOnly(arc, { ...arc, height: 1.2 })).toBe(true);
    expect(
      vizAppearanceOnly(arc, {
        ...arc,
        targetColor: { r: 1, g: 2, b: 3, a: 1 },
      }),
    ).toBe(true);
    expect(
      vizAppearanceOnly(arc, {
        ...arc,
        dest: { kind: "geometry", field: "c" },
      }),
    ).toBe(false);
    // Icon glyph switches redraw from data the client already holds.
    const icon = defaultViz("icon");
    expect(vizAppearanceOnly(icon, { type: "icon", glyph: "cafe" })).toBe(true);
  });

  it("normalizes earlier hexbin resolutions to equivalent edge lengths", () => {
    const legacy = {
      type: "hexbin",
      resolution: 7,
      aggregate: { fn: "count" },
    } as unknown as LayerViz;
    const normalized = normalizeViz(legacy);
    expect(normalized).toEqual({
      type: "hexbin",
      cellKm: 1.22,
      aggregate: { fn: "count" },
    });
    expect(isValidViz(normalized)).toBe(true);
    // Unknown resolutions land on the default; new shapes pass through.
    const odd = normalizeViz({
      type: "hexbin",
      resolution: 99,
      aggregate: { fn: "count" },
    } as unknown as LayerViz);
    expect(odd).toMatchObject({ cellKm: HEX_CELL_KM.default });
    expect(normalizeViz(hexbin)).toBe(hexbin);
    expect(normalizeViz(POINTS_VIZ)).toBe(POINTS_VIZ);
  });
});
