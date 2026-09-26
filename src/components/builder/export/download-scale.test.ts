import { describe, it, expect } from "vitest";
import {
  SIZE_STEPS,
  resolveMapScale,
  type ExportImageDefinition,
} from "@/lib/export/image-definition";
import { chooseSize, elementScale, resolveSpace } from "@/lib/export/space";

/**
 * The download road composites the legend itself (`download.ts`),
 * recomputing its scale from the definition rather than reading the
 * preview's CSS variable — the preview is displayed scaled, and a
 * client rectangle would carry that display factor into the file.
 *
 * That leaves two places computing one number, and they take an
 * argument they did not take before: the composition's HEIGHT. Give one
 * of them the wrong height and a downloaded image carries a legend
 * anchored differently from the widget rail beside it — two anchorings
 * in one file, which the browser suite cannot see because it measures
 * the preview's DOM rather than the produced PNG.
 *
 * So the two are pinned to each other here, in the arithmetic, across
 * every shape and step the card can reach.
 */

/** What `download.ts` computes for the legend, from the definition. */
function downloadRoadScale(def: ExportImageDefinition): number {
  const scale = resolveMapScale(def);
  const spaceWidth = def.size.width / scale;
  const spaceHeight = def.size.height / scale;
  return elementScale(spaceWidth, spaceHeight, def.legend.size);
}

/** What `ExportComposition` gives the preview and the render route. */
function compositionScale(def: ExportImageDefinition): number {
  const scale = resolveMapScale(def);
  return elementScale(
    def.size.width / scale,
    def.size.height / scale,
    def.legend.size,
  );
}

const SHAPES = [
  { width: 1920, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1920 },
  { width: 1920, height: 3840 },
  { width: 2560, height: 915 },
  { width: 1280, height: 435 },
];

describe("the download road and the composition agree on an overlay's scale", () => {
  it("matches for every shape, element step and basemap step", () => {
    for (const raw of SHAPES) {
      const size = chooseSize(raw);
      for (const mapStep of SIZE_STEPS) {
        const resolved = resolveSpace(size, mapStep);
        for (const legendStep of SIZE_STEPS) {
          const def = {
            viewport: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
            size,
            legend: {
              visible: true,
              corner: "bottom-left" as const,
              size: legendStep,
            },
            widgets: [],
            title: null,
            appearance: "light" as const,
            mapScale: resolved.scale,
          };
          expect(
            downloadRoadScale(def),
            `${size.width}x${size.height} map ${mapStep} legend ${legendStep}`,
          ).toBeCloseTo(compositionScale(def), 12);
        }
      }
    }
  });

  it("would part company if either road took the wrong dimension", () => {
    // Red-proof: the agreement above is worth nothing unless a wrong
    // height actually breaks it. A landscape shape, where the width
    // and the short side genuinely differ.
    const size = { width: 1920, height: 1080 };
    const resolved = resolveSpace(size, "s");
    const widthAnchored = elementScale(
      size.width / resolved.scale,
      size.width / resolved.scale,
      "m",
    );
    const shortAnchored = elementScale(
      size.width / resolved.scale,
      size.height / resolved.scale,
      "m",
    );
    expect(widthAnchored).not.toBeCloseTo(shortAnchored, 3);
  });

  it("holds under the earlier scale spelling too", () => {
    const size = { width: 1600, height: 1200 };
    const def = {
      viewport: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
      size,
      legend: { visible: true, corner: "bottom-left" as const, size: "s" as const },
      widgets: [],
      title: null,
      appearance: "light" as const,
      overlayScale: 2,
    };
    expect(downloadRoadScale(def)).toBeCloseTo(compositionScale(def), 12);
  });
});
