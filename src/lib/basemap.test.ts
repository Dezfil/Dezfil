import { describe, it, expect } from "vitest";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import {
  BASEMAP_KEYS,
  BASEMAPS,
  BASEMAP_FALLBACKS,
  BASEMAP_FALLBACK_COLOR,
  BUILT_IN_ATTRIBUTION,
  OFFERED_SETTING,
  SATELLITE_STYLE_URL,
  basemapCreditIn,
  basemapKindIn,
  builtInBasemapUrl,
  isBasemapKey,
  offeredOnly,
  type BasemapStyle,
} from "./basemap";

/**
 * What the browser may know about basemaps: the built-in styles, their
 * credit and the lookups over a list the server handed down. Which styles
 * an instance draws and offers is the server's to read; nothing here reads
 * configuration.
 */
const SATELLITE: BasemapStyle = {
  key: "satellite",
  label: "Satellite",
  url: SATELLITE_STYLE_URL,
  kind: "imagery",
  attribution: [{ label: "© Imagery Provider" }],
};

describe("the built-in basemaps", () => {
  it("ships no imagery style and no keyless imagery url", () => {
    expect(BASEMAPS.map((b) => b.key)).toEqual(["dark", "light", "streets"]);
    for (const b of BASEMAPS) {
      expect(b.kind).toBe("vector");
      expect(b.url).not.toContain("arcgisonline");
    }
  });

  it("every shipped style declares a kind and a non-empty credit", () => {
    for (const b of BASEMAPS) {
      expect(["vector", "imagery"]).toContain(b.kind);
      expect(b.attribution.length).toBeGreaterThan(0);
      for (const line of b.attribution) expect(line.label.length).toBeGreaterThan(0);
    }
  });

  it("links the OpenStreetMap credit to the copyright page", () => {
    const osm = BUILT_IN_ATTRIBUTION.find((l) => l.label.includes("OpenStreetMap"));
    expect(osm!.href).toBe("https://www.openstreetmap.org/copyright");
  });

  it("gives each built-in style its own address", () => {
    expect(builtInBasemapUrl("dark")).toBe(BASEMAPS[0].url);
    expect(builtInBasemapUrl("light")).toContain("positron");
    expect(builtInBasemapUrl("streets")).toBe(BASEMAPS[2].url);
  });

  it("keeps Satellite a valid key though none is shipped", () => {
    expect(isBasemapKey("satellite")).toBe(true);
    expect(isBasemapKey("terrain")).toBe(false);
  });

  it("keeps the historical dark fallback for published views", () => {
    expect(BASEMAP_FALLBACK_COLOR).toBe("#0b0e14");
    expect(BASEMAP_FALLBACKS.dark).toBe(BASEMAP_FALLBACK_COLOR);
  });
});

describe("the offer switches", () => {
  it("name one stored switch per key, each a catalogue row with no variable", () => {
    expect(Object.keys(OFFERED_SETTING)).toEqual([...BASEMAP_KEYS]);
    for (const setting of Object.values(OFFERED_SETTING)) {
      const row = SETTING_CATALOGUE.find((definition) => definition.key === setting);
      expect(row, setting).toMatchObject({ editable: true, defaultValue: true });
      expect(row!.environment, setting).toBeUndefined();
    }
  });
});

describe("a list the server handed down", () => {
  const marked = [...BASEMAPS.map((b) => ({ ...b, offered: b.key !== "streets" })), { ...SATELLITE, offered: true }];

  it("offers what is not marked hidden, an unmarked entry included", () => {
    expect(offeredOnly(marked).map((b) => b.key)).toEqual(["dark", "light", "satellite"]);
    expect(offeredOnly(BASEMAPS)).toEqual(BASEMAPS);
  });

  it("still draws a hidden entry by its own kind and credit", () => {
    expect(basemapKindIn(marked, "satellite")).toBe("imagery");
    expect(basemapCreditIn(marked, "satellite")).toEqual([{ label: "© Imagery Provider" }]);
    expect(basemapKindIn(marked, "streets")).toBe("vector");
    expect(basemapCreditIn(marked, "streets")).toBe(BUILT_IN_ATTRIBUTION);
  });

  it("draws Auto, and a key the list lacks, as vector with the built-in credit", () => {
    for (const key of [null, "satellite"] as const) {
      expect(basemapKindIn(BASEMAPS, key)).toBe("vector");
      expect(basemapCreditIn(BASEMAPS, key)).toBe(BUILT_IN_ATTRIBUTION);
    }
  });
});
