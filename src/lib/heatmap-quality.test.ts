import { describe, expect, it } from "vitest";
import {
  HEATMAP_PREVIEW_TEXTURE_SIZE,
  HEATMAP_SETTLED_TEXTURE_SIZE,
  heatmapLayerId,
  heatmapTextureSize,
  isHeatmapLayerId,
  mergeHeatmapControl,
} from "./heatmap-quality";

describe("adaptive heatmap quality", () => {
  it("uses 256 while interacting and 2048 when settled", () => {
    expect(heatmapTextureSize(true)).toBe(256);
    expect(heatmapTextureSize(false)).toBe(2048);
  });

  it("reduces interactive aggregation work to one sixty-fourth of the pixels", () => {
    expect(
      (HEATMAP_PREVIEW_TEXTURE_SIZE / HEATMAP_SETTLED_TEXTURE_SIZE) ** 2,
    ).toBe(1 / 64);
  });

  it("uses distinct deck identities so each texture size initializes", () => {
    const preview = heatmapLayerId("layer-1", true);
    const settled = heatmapLayerId("layer-1", false);
    expect(preview).not.toBe(settled);
    expect(isHeatmapLayerId(preview, "layer-1")).toBe(true);
    expect(isHeatmapLayerId(settled, "layer-1")).toBe(true);
    expect(isHeatmapLayerId(preview, "layer-2")).toBe(false);
  });

  it("merges one control without reverting another pending draft", () => {
    const base = {
      type: "heatmap" as const,
      radiusPx: 80,
      intensity: 1,
      weight: null,
    };
    const staleCandidate = { ...base, radiusPx: 30, intensity: 4 };
    expect(mergeHeatmapControl(base, staleCandidate, "intensity")).toEqual({
      ...base,
      intensity: 4,
    });
  });
});
