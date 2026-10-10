import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import type { HistoryStep } from "@/lib/metadata/history";
import { BASEMAPS, OFFERED_SETTING, type BasemapKey } from "./basemap";
import { offeredSwitches } from "./basemap-offer";

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
 */

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
