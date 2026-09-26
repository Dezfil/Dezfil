import { describe, it, expect, afterEach } from "vitest";
import {
  autoBasemapUrlForTheme,
  availableBasemaps,
  basemapOverrideAttribution,
  satelliteBasemap,
  satelliteStyleDocument,
  SATELLITE_STYLE_URL,
  basemapFollowsTheme,
  BASEMAPS,
  BASEMAP_FALLBACKS,
  BASEMAP_FALLBACK_COLOR,
  basemapUrl,
  basemapOverrideUrl,
  resolveBasemapUrl,
  resolveBasemapKind,
  resolveBasemapAttribution,
  isBasemapKey,
} from "./basemap";

/**
 * Auto reinterprets null in the builder only — everywhere the server
 * resolves a basemap, null must keep meaning "deployment default" so
 * published output stays viewer-independent and byte-identical.
 */
describe("basemap resolution", () => {
  afterEach(() => {
    delete process.env.DEZFIL_BASEMAP_URL;
  });

  it("resolves null to the deployment default, unchanged", () => {
    expect(basemapOverrideUrl()).toBeNull();
    expect(basemapUrl()).toBe(BASEMAPS[0].url); // dark
    expect(resolveBasemapUrl(null)).toBe(BASEMAPS[0].url);
    expect(resolveBasemapUrl("light")).toBe(BASEMAPS[1].url);
  });

  it("the deployment override wins for null and loses to explicit choices", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    expect(basemapOverrideUrl()).toBe("https://tiles.internal/style.json");
    expect(basemapUrl()).toBe("https://tiles.internal/style.json");
    expect(resolveBasemapUrl(null)).toBe("https://tiles.internal/style.json");
    expect(resolveBasemapUrl("streets")).toBe(BASEMAPS[2].url);
  });

  it("keeps the historical dark fallback for published views", () => {
    expect(BASEMAP_FALLBACK_COLOR).toBe("#0b0e14");
    expect(BASEMAP_FALLBACKS.dark).toBe(BASEMAP_FALLBACK_COLOR);
  });
});

/**
 * Imagery is configured, never shipped: no imagery service is free to
 * point an unknown number of installs at. An instance supplies a tile
 * template with its own key and the credit that provider requires, and
 * only then is there a satellite entry at all.
 */
describe("the configured satellite basemap", () => {
  afterEach(() => {
    delete process.env.DEZFIL_BASEMAP_URL;
    delete process.env.DEZFIL_SATELLITE_URL;
    delete process.env.DEZFIL_SATELLITE_ATTRIBUTION;
  });

  const configure = () => {
    process.env.DEZFIL_SATELLITE_URL =
      "https://imagery.example/tiles/{z}/{y}/{x}?key=SECRET";
    process.env.DEZFIL_SATELLITE_ATTRIBUTION = "© Imagery Provider";
  };

  it("ships no imagery style and no keyless imagery url", () => {
    expect(BASEMAPS.map((b) => b.key)).toEqual(["dark", "light", "streets"]);
    for (const b of BASEMAPS) {
      expect(b.kind).toBe("vector");
      expect(b.url).not.toContain("arcgisonline");
    }
    expect(satelliteBasemap()).toBeNull();
    expect(availableBasemaps().map((b) => b.key)).toEqual([
      "dark",
      "light",
      "streets",
    ]);
    expect(satelliteStyleDocument()).toBeNull();
  });

  it("appears only once imagery is configured, with its own credit", () => {
    configure();
    expect(availableBasemaps().map((b) => b.key)).toEqual([
      "dark",
      "light",
      "streets",
      "satellite",
    ]);
    const satellite = satelliteBasemap()!;
    expect(satellite.kind).toBe("imagery");
    expect(satellite.url).toBe(SATELLITE_STYLE_URL);
    expect(satellite.attribution.map((l) => l.label)).toEqual([
      "© Imagery Provider",
    ]);
    expect(resolveBasemapUrl("satellite")).toBe(SATELLITE_STYLE_URL);
    expect(resolveBasemapKind("satellite")).toBe("imagery");
    expect(resolveBasemapAttribution("satellite")[0].label).toBe(
      "© Imagery Provider",
    );
  });

  it("stays a valid key, and resolves to the default while unconfigured", () => {
    expect(isBasemapKey("satellite")).toBe(true);
    expect(resolveBasemapUrl("satellite")).toBe(BASEMAPS[0].url);
    expect(resolveBasemapKind("satellite")).toBe("vector");
  });

  it("serves the configured template and credit as the style document", () => {
    configure();
    const style = satelliteStyleDocument() as {
      version: number;
      sources: {
        satellite: { type: string; tiles: string[]; attribution: string };
      };
      layers: { type: string }[];
    };
    expect(style.version).toBe(8);
    expect(style.sources.satellite.type).toBe("raster");
    expect(style.sources.satellite.tiles).toEqual([
      "https://imagery.example/tiles/{z}/{y}/{x}?key=SECRET",
    ]);
    expect(style.sources.satellite.attribution).toBe("© Imagery Provider");
    expect(style.layers.map((l) => l.type)).toContain("raster");
  });

  it("beats the deployment override like every explicit choice", () => {
    configure();
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    expect(resolveBasemapUrl("satellite")).toBe(SATELLITE_STYLE_URL);
  });

  it("every shipped style declares a kind and a non-empty credit", () => {
    for (const b of BASEMAPS) {
      expect(["vector", "imagery"]).toContain(b.kind);
      expect(b.attribution.length).toBeGreaterThan(0);
      for (const line of b.attribution) {
        expect(line.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("published theme basemap resolution", () => {
  afterEach(() => {
    delete process.env.DEZFIL_BASEMAP_URL;
  });

  it("Auto follows the effective theme: light resolves the light style, dark the dark", () => {
    expect(autoBasemapUrlForTheme("light")).toContain("positron");
    expect(autoBasemapUrlForTheme("dark")).toContain("dark");
  });

  it("only a genuine Auto with no override follows the theme", () => {
    expect(basemapFollowsTheme(null)).toBe(true);
    expect(basemapFollowsTheme("dark")).toBe(false);
    expect(basemapFollowsTheme("satellite")).toBe(false);
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    expect(basemapFollowsTheme(null)).toBe(false);
  });

  it("a deployment override pins Auto in both themes", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    expect(autoBasemapUrlForTheme("light")).toBe("https://tiles.internal/style.json");
    expect(autoBasemapUrlForTheme("dark")).toBe("https://tiles.internal/style.json");
  });
});

/**
 * The credit has to name the party actually serving the tiles, and the
 * required OpenStreetMap credit has to be followable.
 */
describe("basemap credit correctness", () => {
  afterEach(() => {
    delete process.env.DEZFIL_BASEMAP_URL;
    delete process.env.DEZFIL_BASEMAP_ATTRIBUTION;
  });

  it("links the OpenStreetMap credit to the copyright page", () => {
    for (const key of [null, "dark", "light", "streets"] as const) {
      const osm = resolveBasemapAttribution(key).find((l) =>
        l.label.includes("OpenStreetMap"),
      );
      expect(osm).toBeDefined();
      expect(osm!.href).toBe("https://www.openstreetmap.org/copyright");
    }
  });

  it("credits the configured provider under a deployment override", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    process.env.DEZFIL_BASEMAP_ATTRIBUTION = "© Internal Tiles";
    expect(basemapOverrideAttribution().map((l) => l.label)).toEqual([
      "© Internal Tiles",
    ]);
    const lines = resolveBasemapAttribution(null).map((l) => l.label);
    expect(lines).toEqual(["© Internal Tiles"]);
    expect(lines.join(" ")).not.toContain("OpenMapTiles");
  });

  it("claims nothing when an override names no attribution", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    expect(resolveBasemapAttribution(null)).toEqual([]);
  });

  it("leaves explicit choices on their own credit under an override", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    process.env.DEZFIL_BASEMAP_ATTRIBUTION = "© Internal Tiles";
    expect(resolveBasemapAttribution("light")[0].label).toBe(
      "© OpenMapTiles",
    );
  });
});
