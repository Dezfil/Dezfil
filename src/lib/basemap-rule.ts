import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import type { HistoryStep } from "@/lib/metadata/history";
import type { CustomBasemap, MapRecord } from "@/lib/metadata/maps";
import { BASEMAPS, OFFERED_SETTING, SINGLE_MAP_STYLES_OFF, SINGLE_MAP_STYLES_SETTING, type BasemapKey } from "./basemap";
import { libraryStyle, offeredLibraryStyles } from "./basemap-library";
import { offeredSwitches, singleMapStylesAllowed } from "./basemap-offer";

/**
 * A basemap an admin hid cannot be chosen anew, by any road: the builder,
 * the API, the generated tools and the assistant all reach the map write or
 * the history replay, and both ask here, inside the transaction that writes,
 * so a switch turned while a request was on its way is the one that decides.
 *
 * The rule looks at what the write or the replay would leave the map on,
 * never at which field a request names: a key newly put in place while its
 * style is hidden is refused, whether a write sends it or an undo restores
 * it. Whatever the map is already on is kept, so a map on a hidden style is
 * saved, duplicated and published with it.
 *
 * A style address reads the same way: while an admin has turned off style
 * addresses on single maps, an address newly put in place is refused unless
 * the basemap library offers it, for everyone, admins included. An address
 * the map already holds is kept, and its editor may remove it.
 *
 * A style taken from the library by its id is judged by the library: the id
 * travels with its copy into the write, which refuses it when the style is
 * hidden or gone by then, as it is refused before it is read.
 */

/** The refusal for a library style that is hidden, removed or unknown. */
export function libraryStyleNotOffered(): ApiError {
  return new ApiError("invalid_request", "customBasemap.libraryStyle names no style the basemap library offers now.", 400);
}

/** Refuse taking the library style `id` unless the library offers it now. */
export function requireOfferedLibraryStyle(id: string, db: Database = metadataDb()): void {
  if (!libraryStyle(id, db)?.offered) throw libraryStyleNotOffered();
}

/** The refusal for a hidden style: coded, naming the switch that hides it. */
export function basemapNotOffered(key: BasemapKey): ApiError {
  const label = BASEMAPS.find((b) => b.key === key)?.label ?? "Satellite";
  return new ApiError("basemap_not_offered",
    `${label} is not offered on this instance, so no map can be put on it now. ` +
    "A map already on it keeps it; an admin can offer it again.", 403, { setting: OFFERED_SETTING[key] });
}

/** Refuse leaving a map on `resulting` when that is a style newly put in
 * place (the map is not on it now) and an admin hid it. Auto is always
 * offered. */
export function requireOfferedBasemap(current: BasemapKey | null, resulting: BasemapKey | null,
  db: Database = metadataDb()): void {
  if (resulting === null || resulting === current) return;
  if (!offeredSwitches(db)[resulting]) throw basemapNotOffered(resulting);
}

/** The basemap a replay of these steps, in this direction, leaves a map on
 * that is on `current` now: the last map image carrying one, else `current`. */
export function replayedBasemap(current: BasemapKey | null, steps: HistoryStep[],
  direction: "undo" | "redo"): BasemapKey | null {
  let basemap = current;
  for (const step of steps) {
    const image = direction === "undo" ? step.before : step.after;
    if (step.op === "update" && step.scope === "map" && image && "basemap" in image) {
      basemap = (image.basemap ?? null) as BasemapKey | null;
    }
  }
  return basemap;
}

/** The refusal for a style address while single maps take only the
 * library's styles: coded as a hidden style is, naming the switch. */
export function styleAddressNotOffered(): ApiError {
  return new ApiError("basemap_not_offered", SINGLE_MAP_STYLES_OFF, 403, { setting: SINGLE_MAP_STYLES_SETTING });
}

/** Refuse leaving a map on the style address `resulting` when that is an
 * address newly put in place (the map does not hold it now), single maps
 * take only the library's styles, and the library does not offer it. */
export function requireAllowedStyleAddress(current: string | null, resulting: string | null,
  db: Database = metadataDb()): void {
  if (resulting === null || resulting === current || singleMapStylesAllowed(db)) return;
  if (!offeredLibraryStyles(db).some((style) => style.url === resulting)) throw styleAddressNotOffered();
}

/** The style address a replay of these steps, in this direction, leaves a
 * map on that holds `current` now: the last map image carrying one, else
 * `current`. */
export function replayedStyleAddress(current: string | null, steps: HistoryStep[],
  direction: "undo" | "redo"): string | null {
  let url = current;
  for (const step of steps) {
    const image = direction === "undo" ? step.before : step.after;
    if (step.op === "update" && step.scope === "map" && image && "customBasemap" in image) {
      url = (image.customBasemap as CustomBasemap | null)?.url ?? null;
    }
  }
  return url;
}

/** Refuse a replay that would newly put a map on a hidden style or on a
 * style address this instance does not take now. */
export function requireOfferedReplay(map: Pick<MapRecord, "basemap" | "customBasemap">, steps: HistoryStep[],
  direction: "undo" | "redo", db: Database = metadataDb()): void {
  requireOfferedBasemap(map.basemap, replayedBasemap(map.basemap, steps, direction), db);
  const held = map.customBasemap?.url ?? null;
  requireAllowedStyleAddress(held, replayedStyleAddress(held, steps, direction), db);
}
