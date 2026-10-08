import { mkdtempSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { BASEMAP_KEYS } from "@/lib/basemap";
import { CORNERS } from "@/lib/corners";
import { DEFAULT_EXPORT_WIDTH, EXPORT_WIDTH_PRESETS } from "@/lib/export/image-definition";
import { DEFAULT_OPENING_SHAPE } from "@/lib/export/space";
import { DEFAULT_CATEGORICAL, PALETTES } from "@/lib/style/palettes";
import { ASPECT_PRESETS } from "@/components/builder/export/aspect";
import { SETTING_CATALOGUE, settingDefinition } from "./catalogue";
import { writeStoredSettings } from "./store";
import { instanceDefaults, resolveInstanceDefaults, type InstanceDefaults } from "./defaults";

/** What new things start with when no admin changed anything: the product's
 * own values, as the approved table states them, with the basemap and the
 * legend corner unset, so a new map stores neither, as before. */
const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;

/** Every default changed by an admin, none to its product value. */
const STORED = {
  "newMap.basemap": "satellite", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
} as const satisfies InstanceDefaults;

const ALL_OFFERED = [...BASEMAP_KEYS];
const BUILT_IN = BASEMAP_KEYS.filter(key => key !== "satellite");
const opened: Database[] = [];
beforeEach(() => vi.stubEnv("DEZFIL_SATELLITE_URL", ""));
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); vi.unstubAllEnvs(); });
function store(file = ":memory:") { const db = open(file); opened.push(db); return db; }

describe("the defaults for new things", () => {
  it("resolve to the product's values with nothing stored, the basemap and the legend corner unset", () => {
    expect(resolveInstanceDefaults({}, ALL_OFFERED)).toEqual(PRODUCT);
    expect(resolveInstanceDefaults({}, BUILT_IN)).toEqual(PRODUCT);
    expect(instanceDefaults(store())).toEqual(PRODUCT);
  });

  it("are one record keyed by every default the catalogue defines", () => {
    const keys = SETTING_CATALOGUE.filter(definition => definition.readBy === "signed-in").map(definition => definition.key);
    expect(keys).toHaveLength(18);
    expect(Object.keys(resolveInstanceDefaults({}, ALL_OFFERED)).sort()).toEqual([...keys].sort());
    expect(Object.keys(resolveInstanceDefaults(STORED, ALL_OFFERED)).sort()).toEqual([...keys].sort());
    // A record with no entry for a default is not the defaults: the type check refuses it.
    const { "imageExport.shape": shape, ...withoutShape } = PRODUCT;
    // @ts-expect-error: imageExport.shape has no entry.
    const missing: InstanceDefaults = withoutShape;
    expect([shape, Object.keys(missing).length]).toEqual(["4:3", 17]);
  });

  it("resolve every key from what an admin stored, through a reopened store", () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.jpg");
    const file = path.join(mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "defaults-")), "metadata.sqlite");
    const first = store(file);
    writeStoredSettings(STORED, first);
    first.close();
    expect(instanceDefaults(store(file))).toEqual(STORED);
  });

  it("start a new map on Auto when the stored basemap is Satellite and the instance offers no imagery", () => {
    const stored = { "newMap.basemap": "satellite" };
    expect(resolveInstanceDefaults(stored, BUILT_IN)["newMap.basemap"]).toBeNull();
    expect(resolveInstanceDefaults(stored, ALL_OFFERED)["newMap.basemap"]).toBe("satellite");
    const db = store();
    writeStoredSettings(stored, db);
    expect(instanceDefaults(db)["newMap.basemap"]).toBeNull();
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.jpg");
    expect(instanceDefaults(db)["newMap.basemap"]).toBe("satellite");
    for (const key of BUILT_IN) expect(resolveInstanceDefaults({ "newMap.basemap": key }, BUILT_IN)["newMap.basemap"]).toBe(key);
  });

  it("keep the basemap and the legend corner unset at the product's value, even when an admin stored it", () => {
    const stored = resolveInstanceDefaults({ "newMap.basemap": "auto", "newMap.legendCorner": "bottom-left" }, ALL_OFFERED);
    expect(stored["newMap.basemap"]).toBeNull();
    expect(stored["newMap.legendCorner"]).toBeNull();
    for (const corner of CORNERS.filter(corner => corner !== "bottom-left")) {
      expect(resolveInstanceDefaults({ "newMap.legendCorner": corner }, ALL_OFFERED)["newMap.legendCorner"]).toBe(corner);
    }
  });

  it("take the product's value for a stored value the catalogue would refuse", () => {
    expect(resolveInstanceDefaults({ "newMap.zoom": 23, "newLayer.pointOpacity": 5, "newLayer.lineWidth": 0, "canvas.opens": "sideways",
      "sqlConsole.lineWrap": "true", "imageExport.width": 1920, "newMap.basemap": "satellite-v2", "newMap.latitude": null }, ALL_OFFERED)).toEqual(PRODUCT);
  });

  it("offer exactly the product's own basemaps, corners, cycle palettes, image widths and shapes, starting where the product starts", () => {
    const values = (key: string) => (settingDefinition(key).write as { values: readonly string[] }).values;
    expect(values("newMap.basemap")).toEqual(["auto", ...BASEMAP_KEYS]);
    expect(values("newMap.legendCorner")).toEqual([...CORNERS]);
    expect(values("newLayer.colorCycle")).toEqual(PALETTES.filter(palette => palette.kind === "categorical").map(palette => palette.name));
    expect(settingDefinition("newLayer.colorCycle").defaultValue).toBe(DEFAULT_CATEGORICAL);
    expect(values("imageExport.width")).toEqual(EXPORT_WIDTH_PRESETS.map(String));
    expect(settingDefinition("imageExport.width").defaultValue).toBe(String(DEFAULT_EXPORT_WIDTH));
    expect(values("imageExport.shape")).toEqual(ASPECT_PRESETS.map(preset => preset.label));
    expect(settingDefinition("imageExport.shape").defaultValue).toBe(`${DEFAULT_OPENING_SHAPE.width}:${DEFAULT_OPENING_SHAPE.height}`);
  });
});
