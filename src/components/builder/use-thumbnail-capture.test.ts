import { describe, expect, it } from "vitest";
import { BASEMAPS, BASEMAP_FALLBACKS } from "@/lib/basemap";
import { capturePlan, thumbnailCyclePlan } from "./use-thumbnail-capture";
import { mapSqlRevision } from "@/lib/map-sql-revision";

/** Which maps take a second card image: only a genuine Auto. */
describe("the thumbnail cycle plan", () => {
  const theming = {
    theme: "light" as const,
    basemapUrl: BASEMAPS[0].url,
    basemapOverrideUrl: null,
  };
  const auto = { basemap: null, customBasemap: null, basemapLayers: { roads: false } };

  it("a map on Auto takes the other theme's bundled style, its toggles and that theme's fallback", () => {
    expect(thumbnailCyclePlan(auto, theming)).toEqual({
      themed: {
        theme: "light",
        live: {
          theme: "light",
          styleUrl: BASEMAPS.find((b) => b.key === "light")!.url,
          fallbackColor: BASEMAP_FALLBACKS.light,
        },
        other: {
          theme: "dark",
          styleUrl: BASEMAPS.find((b) => b.key === "dark")!.url,
          fallbackColor: BASEMAP_FALLBACKS.dark,
        },
        basemapLayers: { roads: false },
        basemapKind: "vector",
      },
    });
    expect(thumbnailCyclePlan(auto, { ...theming, theme: "dark" }).themed).toMatchObject({
      theme: "dark",
      other: { theme: "light", styleUrl: BASEMAPS.find((b) => b.key === "light")!.url },
    });
  });

  it("a chosen basemap, a custom style, or a pinned deployment keeps one image", () => {
    expect(thumbnailCyclePlan({ ...auto, basemap: "streets" }, theming)).toEqual({ themed: null });
    expect(
      thumbnailCyclePlan(
        { ...auto, customBasemap: { url: "https://s.test/x.json", name: null, attribution: [] } },
        theming,
      ),
    ).toEqual({ themed: null });
    expect(
      thumbnailCyclePlan(auto, { ...theming, basemapOverrideUrl: "https://pin.test/s.json" }),
    ).toEqual({ themed: null });
  });
});

describe("the revision a capture plan carries", () => {
  const theming = { theme: "light" as const, basemapUrl: BASEMAPS[0].url, basemapOverrideUrl: null };
  const map = {
    basemap: "streets" as const, customBasemap: null, basemapLayers: null,
    layers: [{ id: "a", sql: "SELECT * FROM roads" }, { id: "b", sql: "SELECT * FROM bo.roads" }],
  };

  it("is the map's SQL revision as the builder holds it, beside the theming decision", () => {
    const plan = capturePlan(map, theming);
    expect(plan.themed).toBeNull();
    expect(plan.revision).toBe(mapSqlRevision(map.layers));
    expect(plan.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("moves with any layer's SQL, its identity or the layer order, and nothing else", () => {
    const base = capturePlan(map, theming).revision;
    expect(capturePlan({ ...map, basemap: "light" }, theming).revision).toBe(base);
    expect(capturePlan({ ...map, layers: [map.layers[0], { id: "b", sql: "SELECT * FROM roads" }] }, theming).revision).not.toBe(base);
    expect(capturePlan({ ...map, layers: [map.layers[0], { id: "c", sql: map.layers[1].sql }] }, theming).revision).not.toBe(base);
    expect(capturePlan({ ...map, layers: [map.layers[1], map.layers[0]] }, theming).revision).not.toBe(base);
  });

  it("is absent when the map's layers are not known", () => {
    expect(capturePlan({ basemap: "streets", customBasemap: null, basemapLayers: null }, theming).revision).toBeUndefined();
  });
});
