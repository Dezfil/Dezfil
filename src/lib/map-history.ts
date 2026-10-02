import { assertHistoryRefs } from "./map-history-refs";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { removeTileArtifacts } from "@/lib/tiles/build";
import { insertLayer, updateMapFields, updateLayerFields, deleteLayer, reorderLayers,
  type Layer, type MapWithLayers } from "@/lib/metadata/maps";
import { undoSteps, redoSteps, setHistoryCursor, historyAvailability,
  type HistoryAvailability, type HistoryImage, type HistoryStep } from "@/lib/metadata/history";
import { requireMap, requireMapFor, mapWithLayersFor } from "./map-access";
import { historyChangesPublication } from "./publication-settings";
import { listLayers } from "@/lib/metadata/maps";
import { admitMapSql, recheckSaved, savesAsOwner, type SavedAdmission } from "./save-admission";

/** The map + fresh history availability — what undo/redo return, and what
 * the builder seeds its buttons from. */
export interface MapWithHistory extends MapWithLayers {
  history: HistoryAvailability;
}

export function mapHistory(scope: AccountScope, id: string): HistoryAvailability {
  requireMap(scope, id);
  return historyAvailability(id);
}

/**
 * Apply one step's recorded image — verbatim, straight to the repositories,
 * never through the edit pipeline: coupled server-side adjustments must not
 * drift a revert. Rows deleted here are collected so their tile artifacts
 * can be removed after the transaction.
 */
function applyStep(
  step: HistoryStep,
  direction: "undo" | "redo",
  removedLayers: string[],
): void {
  const image = direction === "undo" ? step.before : step.after;
  if (step.op === "update") {
    if (step.scope === "map") {
      const { layerOrder, ...rest } = image as HistoryImage & {
        layerOrder?: string[];
      };
      if (Object.keys(rest).length) {
        updateMapFields(step.targetId, rest as Parameters<typeof updateMapFields>[1]);
      }
      if (layerOrder) reorderLayers(step.mapId, layerOrder);
    } else {
      updateLayerFields(
        step.targetId,
        image as Parameters<typeof updateLayerFields>[1],
      );
    }
    return;
  }
  // add/delete: undoing an add (or redoing a delete) removes the row;
  // the opposite direction re-inserts the recorded row whole — same id,
  // same ordinal, so later steps referencing it stay valid.
  const removes =
    (step.op === "add") === (direction === "undo");
  if (removes) {
    deleteLayer(step.targetId);
    removedLayers.push(step.targetId);
  } else {
    insertLayer(image as unknown as Layer);
  }
}

/** The layer SQL a replay would put back: a layer update's recorded SQL, or a
 * whole layer re-inserted. */
function restoredSql(steps: HistoryStep[], direction: "undo" | "redo"): string[] {
  const sql = new Set<string>();
  for (const step of steps) {
    const image = direction === "undo" ? step.before : step.after;
    if (step.scope === "layer" && image && typeof image.sql === "string") sql.add(image.sql);
  }
  return [...sql];
}

const stepKey = (steps: HistoryStep[]) => steps.map((step) => step.id).join("|");

/**
 * A replay by someone other than the map's owner restores SQL only on the
 * terms of a direct save: every dataset it names within their own reach in
 * the map's home. Admitted before the replay's transaction, which applies
 * only the steps admitted and refuses whole if the timeline moved meanwhile.
 */
async function admitReplay(scope: AccountScope, id: string, direction: "undo" | "redo"):
  Promise<{ key: string; saved: SavedAdmission[] } | null> {
  const map = requireMapFor(scope, id, "edit");
  if (savesAsOwner(scope, "map", id)) return null;
  const steps = direction === "undo" ? undoSteps(id) : redoSteps(id);
  // A replay that would change a publication setting is refused before any
  // SQL it restores is evaluated.
  if (historyChangesPublication(map, listLayers(id), steps, direction)) requireMapFor(scope, id, "publish");
  const saved: SavedAdmission[] = [];
  for (const sql of restoredSql(steps, direction)) saved.push(await admitMapSql(scope, id, sql));
  return { key: stepKey(steps), saved };
}

async function applyHistory(
  scope: AccountScope,
  id: string,
  direction: "undo" | "redo",
): Promise<MapWithHistory> {
  const removedLayers: string[] = [];
  const admitted = await admitReplay(scope, id, direction);
  metadataDb().transaction(() => {
    // Undo and redo are content changes; one that would put back or take
    // away a publication setting is the owner's alone, refused whole.
    const map = requireMapFor(scope, id, "edit");
    const steps = direction === "undo" ? undoSteps(id) : redoSteps(id);
    if (steps.length === 0) {
      throw new ApiError(
        "invalid_request",
        direction === "undo" ? "Nothing to undo." : "Nothing to redo.",
        409,
      );
    }
    if (historyChangesPublication(map, listLayers(id), steps, direction)) requireMapFor(scope, id, "publish");
    // The steps applied are the steps admitted, by the standing admitted.
    const owner = savesAsOwner(scope, "map", id);
    if (admitted ? owner || admitted.key !== stepKey(steps) : !owner) {
      throw new ApiError("invalid_request", "The map changed while the change was being checked. Try again.", 409);
    }
    if (admitted) recheckSaved(scope, ...admitted.saved);
    assertHistoryRefs(scope, id, steps, direction);
    for (const step of steps) applyStep(step, direction, removedLayers);
    const last = steps[steps.length - 1];
    setHistoryCursor(id, direction === "undo" ? last.seq - 1 : last.seq);
  })();
  await Promise.all(removedLayers.map((lid) => removeTileArtifacts(lid)));
  return { ...mapWithLayersFor(scope, id, "edit"), history: historyAvailability(id) };
}

/** Revert the newest step — or the whole group an assistant turn wrote. */
export function undoChange(scope: AccountScope, id: string): Promise<MapWithHistory> {
  return applyHistory(scope, id, "undo");
}

/** Re-apply the newest undone step (or group). */
export function redoChange(scope: AccountScope, id: string): Promise<MapWithHistory> {
  return applyHistory(scope, id, "redo");
}
