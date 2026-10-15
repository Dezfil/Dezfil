import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { BASEMAPS, BUILT_IN_ATTRIBUTION, SATELLITE_STYLE_URL } from "./basemap";
import {
  autoBasemapUrlForTheme,
  basemapChoices,
  basemapFollowsTheme,
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
  drawingBasemaps,
  offeredBasemaps,
  offeredSwitches,
  resolveBasemapAttribution,
  resolveBasemapKind,
  resolveBasemapUrl,
} from "./basemap-offer";
import { satelliteBasemap, satelliteStyleDocument } from "./basemap-satellite";

/**
 * Which basemaps the instance draws and which it offers, read on the server
 * from the deployment's configuration and the store. The drawing list holds
 * every style a map may be on; the offer is that list less what an admin
 * hid. Auto reinterprets null in the builder only: everywhere the server
 * resolves a basemap, null keeps meaning the deployment default, so
 * published output stays viewer-independent.
 */
const TEMPLATE = "https://imagery.example/tiles/{z}/{y}/{x}?key=SEEDED-KEY-0005-QUERY";
const keys = (list: { key: string }[]) => list.map((b) => b.key);
let db: Database;

beforeEach(() => {
  for (const name of ["DEZFIL_BASEMAP_URL", "DEZFIL_BASEMAP_ATTRIBUTION", "DEZFIL_SATELLITE_URL", "DEZFIL_SATELLITE_ATTRIBUTION"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("DEZFIL_SECRET_KEY", "5e".repeat(32));
  resetSecretKeyCache();
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetSecretKeyCache(); db.close(); });

const configure = () => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", TEMPLATE);
  vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Imagery Provider");
};

describe("basemap resolution", () => {
  it("resolves null to the deployment default, unchanged", () => {
    expect(basemapOverrideUrl()).toBeNull();
    expect(basemapUrl()).toBe(BASEMAPS[0].url);
    expect(resolveBasemapUrl(null)).toBe(BASEMAPS[0].url);
    expect(resolveBasemapUrl("light")).toBe(BASEMAPS[1].url);
  });

  it("the deployment override wins for null and loses to explicit choices", () => {
    vi.stubEnv("DEZFIL_BASEMAP_URL", "https://tiles.internal/style.json");
    expect(basemapOverrideUrl()).toBe("https://tiles.internal/style.json");
    expect(basemapUrl()).toBe("https://tiles.internal/style.json");
    expect(resolveBasemapUrl(null)).toBe("https://tiles.internal/style.json");
    expect(resolveBasemapUrl("streets")).toBe(BASEMAPS[2].url);
  });

  it("Auto follows the effective theme on a publication, and only a genuine Auto with no override does", () => {
    expect(autoBasemapUrlForTheme("light")).toContain("positron");
    expect(autoBasemapUrlForTheme("dark")).toContain("dark");
    expect(basemapFollowsTheme(null)).toBe(true);
    expect(basemapFollowsTheme("dark")).toBe(false);
    expect(basemapFollowsTheme("satellite")).toBe(false);
    vi.stubEnv("DEZFIL_BASEMAP_URL", "https://tiles.internal/style.json");
    expect(basemapFollowsTheme(null)).toBe(false);
    expect(autoBasemapUrlForTheme("light")).toBe("https://tiles.internal/style.json");
    expect(autoBasemapUrlForTheme("dark")).toBe("https://tiles.internal/style.json");
  });
});

describe("basemap credit correctness", () => {
  it("links the OpenStreetMap credit to the copyright page", () => {
    for (const key of [null, "dark", "light", "streets"] as const) {
      const osm = resolveBasemapAttribution(key).find((l) => l.label.includes("OpenStreetMap"));
      expect(osm!.href).toBe("https://www.openstreetmap.org/copyright");
    }
  });

  it("credits the configured provider under a deployment override, and claims nothing without one", () => {
    vi.stubEnv("DEZFIL_BASEMAP_URL", "https://tiles.internal/style.json");
    expect(resolveBasemapAttribution(null)).toEqual([]);
    vi.stubEnv("DEZFIL_BASEMAP_ATTRIBUTION", "© Internal Tiles");
    expect(basemapOverrideAttribution().map((l) => l.label)).toEqual(["© Internal Tiles"]);
    expect(resolveBasemapAttribution(null).map((l) => l.label)).toEqual(["© Internal Tiles"]);
    // Explicit choices keep their own credit under an override.
    expect(resolveBasemapAttribution("light")).toBe(BUILT_IN_ATTRIBUTION);
  });
});

/**
 * Imagery is configured, never shipped: an instance supplies a tile template
 * with its own key and the credit that provider requires, by variable or
 * stored by an admin, and only then is there a satellite entry at all.
 */
describe("the configured satellite basemap", () => {
  it("is absent, and resolves to the default, while no template is set", () => {
    expect(satelliteBasemap()).toBeNull();
    expect(satelliteStyleDocument()).toBeNull();
    expect(keys(drawingBasemaps())).toEqual(["dark", "light", "streets"]);
    expect(resolveBasemapUrl("satellite")).toBe(BASEMAPS[0].url);
    expect(resolveBasemapKind("satellite")).toBe("vector");
  });

  it("appears once a variable sets it, with its own credit, and beats the deployment override", () => {
    configure();
    expect(keys(drawingBasemaps())).toEqual(["dark", "light", "streets", "satellite"]);
    expect(satelliteBasemap()).toEqual({ key: "satellite", label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery",
      attribution: [{ label: "© Imagery Provider" }] });
    expect(resolveBasemapUrl("satellite")).toBe(SATELLITE_STYLE_URL);
    expect(resolveBasemapKind("satellite")).toBe("imagery");
    expect(resolveBasemapAttribution("satellite")).toEqual([{ label: "© Imagery Provider" }]);
    vi.stubEnv("DEZFIL_BASEMAP_URL", "https://tiles.internal/style.json");
    expect(resolveBasemapUrl("satellite")).toBe(SATELLITE_STYLE_URL);
  });

  it("serves the credit in effect as the style document, its tiles at the instance's own address and never the template", () => {
    configure();
    const style = satelliteStyleDocument() as { version: number; layers: { type: string }[];
      sources: { satellite: { type: string; tiles: string[]; attribution: string } } };
    expect(style.version).toBe(8);
    expect(style.sources.satellite).toMatchObject({ type: "raster", tiles: ["/api/basemaps/satellite/tiles/{z}/{x}/{y}"], attribution: "© Imagery Provider" });
    expect(style.layers.map((l) => l.type)).toContain("raster");
    expect(JSON.stringify(style)).not.toContain("imagery.example");
    // Served under another address, the tiles follow that address.
    expect((satelliteStyleDocument("/api/published/T/basemaps/satellite") as { sources: { satellite: { tiles: string[] } } })
      .sources.satellite.tiles).toEqual(["/api/published/T/basemaps/satellite/tiles/{z}/{x}/{y}"]);
  });

  it("appears once an admin stores a template, with the stored credit, a set variable winning each", () => {
    writeStoredSettings({ satelliteUrl: TEMPLATE, satelliteAttribution: "© Stored Provider" }, db);
    expect(satelliteBasemap()?.attribution).toEqual([{ label: "© Stored Provider" }]);
    expect((satelliteStyleDocument() as { sources: { satellite: { tiles: string[] } } }).sources.satellite.tiles).toEqual(["/api/basemaps/satellite/tiles/{z}/{x}/{y}"]);
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", " © Variable Provider ");
    expect(satelliteBasemap()?.attribution).toEqual([{ label: "© Variable Provider" }]);
  });

  it("leaves the drawing list while a stored template is unreadable, and the style document refuses", () => {
    writeStoredSettings({ satelliteUrl: TEMPLATE }, db);
    vi.stubEnv("DEZFIL_SECRET_KEY", "6f".repeat(32));
    resetSecretKeyCache();
    expect(satelliteBasemap()).toBeNull();
    expect(keys(drawingBasemaps())).toEqual(["dark", "light", "streets"]);
    expect(() => satelliteStyleDocument()).toThrow(expect.objectContaining({ code: "service_address_unreadable" }));
  });
});

describe("the offer", () => {
  it("offers every style it draws while nothing is hidden", () => {
    configure();
    expect(offeredSwitches()).toEqual({ dark: true, light: true, streets: true, satellite: true });
    expect(offeredBasemaps()).toEqual(drawingBasemaps());
    expect(basemapChoices().map((b) => [b.key, b.offered])).toEqual([["dark", true], ["light", true], ["streets", true], ["satellite", true]]);
  });

  it("leaves out each hidden style while the drawing list keeps it, marked on the choices", () => {
    configure();
    writeStoredSettings({ "basemaps.streets": false, "basemaps.satellite": false }, db);
    expect(offeredSwitches()).toEqual({ dark: true, light: true, streets: false, satellite: false });
    expect(keys(offeredBasemaps())).toEqual(["dark", "light"]);
    expect(keys(drawingBasemaps())).toEqual(["dark", "light", "streets", "satellite"]);
    expect(basemapChoices().map((b) => [b.key, b.offered])).toEqual([["dark", true], ["light", true], ["streets", false], ["satellite", false]]);
    // A map on a hidden style is still drawn on it, with its own kind and credit.
    expect(resolveBasemapUrl("streets")).toBe(BASEMAPS[2].url);
    expect(resolveBasemapUrl("satellite")).toBe(SATELLITE_STYLE_URL);
    expect(resolveBasemapKind("satellite")).toBe("imagery");
    expect(resolveBasemapAttribution("satellite")).toEqual([{ label: "© Imagery Provider" }]);
  });

  it("does not offer Satellite while no template is set, its switch on or not", () => {
    expect(offeredSwitches().satellite).toBe(true);
    expect(keys(offeredBasemaps())).toEqual(["dark", "light", "streets"]);
  });
});
