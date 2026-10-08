import type { Database } from "better-sqlite3";
import { availableBasemaps, type BasemapKey } from "@/lib/basemap";
import type { Corner } from "@/lib/corners";
import { metadataDb } from "@/lib/metadata/db";
import { INSTANCE_DEFAULT_SETTINGS, type InstanceDefaultKey, type InstanceDefaultValue } from "./instance-defaults";
import { readStoredSettings } from "./store";
import { validateStoredValue } from "./validation";

/** How a new thing takes a default. Two differ from the stored value: the
 * basemap and the legend corner resolve to null, unset, at the product's
 * value, so a new map stores neither, exactly as before, and keeps reading
 * Auto and each surface's own fallback corner. */
type Effective<K extends InstanceDefaultKey> =
  K extends "newMap.basemap" ? BasemapKey | null
    : K extends "newMap.legendCorner" ? Corner | null
      : InstanceDefaultValue<K>;

/** What new things start with: one value for every default, so a default
 * defined with no entry here fails the type check. */
export type InstanceDefaults = { readonly [K in InstanceDefaultKey]: Effective<K> };

const DEFINITIONS = new Map(INSTANCE_DEFAULT_SETTINGS.map(definition => [definition.key as InstanceDefaultKey, definition]));

/** The stored value where the catalogue accepts it, else the product's own. */
function valueOf<K extends InstanceDefaultKey>(key: K, stored: Readonly<Record<string, unknown>>): InstanceDefaultValue<K> {
  const definition = DEFINITIONS.get(key)!;
  const kept = Object.hasOwn(stored, key) ? validateStoredValue(definition, stored[key]) : null;
  return (kept?.ok && kept.value !== null ? kept.value : definition.defaultValue) as InstanceDefaultValue<K>;
}

/**
 * The defaults over the product's own values, from the stored values and
 * the basemaps the instance offers. A stored basemap it no longer offers
 * (Satellite once imagery is removed) starts a new map on Auto, as Auto at
 * the product's value does; the product's corner leaves the corner unset.
 */
export function resolveInstanceDefaults(stored: Readonly<Record<string, unknown>>, offered: readonly BasemapKey[]): InstanceDefaults {
  const value = <K extends InstanceDefaultKey>(key: K) => valueOf(key, stored);
  const basemap = value("newMap.basemap"), corner = value("newMap.legendCorner");
  return {
    "newMap.basemap": basemap !== "auto" && offered.includes(basemap) ? basemap : null,
    "newMap.latitude": value("newMap.latitude"),
    "newMap.longitude": value("newMap.longitude"),
    "newMap.zoom": value("newMap.zoom"),
    "newMap.legendCorner": corner === DEFINITIONS.get("newMap.legendCorner")!.defaultValue ? null : corner,
    "newLayer.colorCycle": value("newLayer.colorCycle"),
    "newLayer.pointOpacity": value("newLayer.pointOpacity"),
    "newLayer.lineOpacity": value("newLayer.lineOpacity"),
    "newLayer.areaOpacity": value("newLayer.areaOpacity"),
    "newLayer.lineWidth": value("newLayer.lineWidth"),
    "newLayer.pointRadius": value("newLayer.pointRadius"),
    "canvas.opens": value("canvas.opens"),
    "canvas.minimap": value("canvas.minimap"),
    "canvas.resultsBand": value("canvas.resultsBand"),
    "sqlConsole.textSize": value("sqlConsole.textSize"),
    "sqlConsole.lineWrap": value("sqlConsole.lineWrap"),
    "imageExport.width": value("imageExport.width"),
    "imageExport.shape": value("imageExport.shape"),
  };
}

/** What a new thing starts with on this instance now. Pass the creating
 * transaction's handle to read inside it. */
export function instanceDefaults(db: Database = metadataDb()): InstanceDefaults {
  return resolveInstanceDefaults(readStoredSettings(db), availableBasemaps().map(basemap => basemap.key));
}
