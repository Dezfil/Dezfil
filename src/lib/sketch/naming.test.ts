import { describe, expect, it } from "vitest";
import { sketchBaseName } from "./naming";

describe("sketchBaseName", () => {
  it("normalizes the map name first, then appends the suffix", () => {
    expect(sketchBaseName("Berlin mobility risk")).toBe(
      "berlin_mobility_risk_sketch",
    );
  });

  it("keeps a dotted map name whole — the v1 defect case", () => {
    expect(sketchBaseName("Map v1.2")).toBe("map_v1_2_sketch");
  });

  it("strips diacritics and squashes symbol runs", () => {
    expect(sketchBaseName("Über Karte — Süd")).toBe("uber_karte_sud_sketch");
  });

  it("prefixes a leading digit and falls back on an empty stem", () => {
    expect(sketchBaseName("2024 review")).toBe("t2024_review_sketch");
    expect(sketchBaseName("###")).toBe("map_sketch");
  });
});
