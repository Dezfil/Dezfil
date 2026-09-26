import { describe, expect, it } from "vitest";
import { BASEMAPS, BASEMAP_FALLBACKS } from "@/lib/basemap";
import { thumbnailCyclePlan } from "./use-thumbnail-capture";

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
