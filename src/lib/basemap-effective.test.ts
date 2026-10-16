import { describe, it, expect } from "vitest";
import { effectiveBasemap, imageryMissing } from "./basemap-effective";
import { BASEMAPS, BUILT_IN_ATTRIBUTION } from "./basemap";

const custom = {
  url: "https://styles.example/dark.json",
  name: "Company dark",
  attribution: [{ label: "© Somebody" }],
};
const base = {
  key: null,
  custom: null,
  theme: "dark" as const,
  overrideUrl: null,
  defaultUrl: BASEMAPS[0].url,
};

describe("effective basemap", () => {
  it("a custom style wins outright, vector kind, snapshot credit, both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const result = effectiveBasemap({
        ...base,
        key: "streets",
        custom,
        theme,
      });
      expect(result).toEqual({
        url: custom.url,
        kind: "vector",
        attribution: custom.attribution,
        custom: true,
        followsTheme: false,
      });
    }
  });

  it("without one, an explicit key keeps its url, kind and credit", () => {
    const imagery = {
      key: "satellite" as const,
      label: "Satellite",
      url: "/api/basemaps/satellite",
      kind: "imagery" as const,
      attribution: [{ label: "© Imagery Provider" }],
    };
    const satellite = effectiveBasemap({
      ...base,
      key: "satellite",
      basemaps: [...BASEMAPS, imagery],
    });
    expect(satellite.url).toBe("/api/basemaps/satellite");
    expect(satellite.kind).toBe("imagery");
    expect(satellite.attribution[0].label).toBe("© Imagery Provider");
    expect(satellite.custom).toBe(false);
  });

  it("an imagery key the instance does not configure reads as the default, with the default's credit", () => {
    const satellite = effectiveBasemap({ ...base, key: "satellite" });
    expect(satellite.url).toBe(base.defaultUrl);
    expect(satellite.kind).toBe("vector");
    expect(satellite.attribution).toEqual(BUILT_IN_ATTRIBUTION);
    // A deployment's own style is the default: its configured credit, or none.
    const own = "https://pin.test/s.json";
    const pinned = { ...base, key: "satellite" as const, overrideUrl: own, defaultUrl: own };
    expect(effectiveBasemap({ ...pinned, overrideAttribution: [{ label: "© Pin" }] })).toMatchObject({ url: own, kind: "vector", attribution: [{ label: "© Pin" }] });
    expect(effectiveBasemap(pinned)).toMatchObject({ url: own, kind: "vector", attribution: [] });
  });

  it("tells a Satellite map with no imagery from one whose imagery is drawn, hidden or not, and from a map under its own style", () => {
    const imagery = { key: "satellite" as const, label: "Satellite", url: "/api/basemaps/satellite", kind: "imagery" as const, attribution: [] };
    expect(imageryMissing({ key: "satellite", custom: false, basemaps: BASEMAPS })).toBe(true);
    // What the picker says agrees with what is drawn and credited.
    expect(effectiveBasemap({ ...base, key: "satellite", basemaps: BASEMAPS })).toMatchObject({ url: base.defaultUrl, attribution: BUILT_IN_ATTRIBUTION });
    expect(imageryMissing({ key: "satellite", custom: false, basemaps: [...BASEMAPS, imagery] })).toBe(false);
    expect(imageryMissing({ key: "satellite", custom: false, basemaps: [...BASEMAPS, { ...imagery, offered: false }] })).toBe(false);
    expect(imageryMissing({ key: "satellite", custom: true, basemaps: BASEMAPS })).toBe(false);
    expect(imageryMissing({ key: "streets", custom: false, basemaps: BASEMAPS })).toBe(false);
    expect(imageryMissing({ key: null, custom: false, basemaps: BASEMAPS })).toBe(false);
  });

  it("Auto follows the theme unless the deployment override pins it", () => {
    expect(effectiveBasemap({ ...base, theme: "light" }).url).toBe(
      BASEMAPS.find((b) => b.key === "light")!.url,
    );
    expect(effectiveBasemap({ ...base, theme: "dark" }).url).toBe(
      BASEMAPS.find((b) => b.key === "dark")!.url,
    );
    expect(
      effectiveBasemap({ ...base, overrideUrl: "https://pin.test/s.json" })
        .url,
    ).toBe("https://pin.test/s.json");
  });

  it("only a genuine Auto follows the theme: no custom style, no key, no override", () => {
    expect(effectiveBasemap(base).followsTheme).toBe(true);
    expect(effectiveBasemap({ ...base, theme: "light" }).followsTheme).toBe(true);
    expect(effectiveBasemap({ ...base, key: "light" }).followsTheme).toBe(false);
    expect(effectiveBasemap({ ...base, custom }).followsTheme).toBe(false);
    expect(
      effectiveBasemap({ ...base, overrideUrl: "https://pin.test/s.json" })
        .followsTheme,
    ).toBe(false);
  });

  it("with Dark and Light hidden, Auto still follows the theme and an explicit Dark or Light never moves with it", () => {
    // The builder's list marks the hidden styles; it has no Dark/Light
    // pairing of its own, only Auto following the theme.
    const basemaps = BASEMAPS.map((b) => ({ ...b, offered: b.key !== "dark" && b.key !== "light" }));
    const url = (key: string) => BASEMAPS.find((b) => b.key === key)!.url;
    for (const theme of ["light", "dark"] as const) {
      expect(effectiveBasemap({ ...base, basemaps, theme }).url).toBe(url(theme));
      for (const key of ["dark", "light"] as const) {
        expect(effectiveBasemap({ ...base, basemaps, theme, key }).url).toBe(url(key));
      }
    }
  });

  it("clearing custom reveals the key's own resolution again", () => {
    const withCustom = effectiveBasemap({ ...base, key: "streets", custom });
    const cleared = effectiveBasemap({ ...base, key: "streets" });
    expect(withCustom.url).toBe(custom.url);
    expect(cleared.url).toBe(
      BASEMAPS.find((b) => b.key === "streets")!.url,
    );
  });
});
