import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { removeTileArtifacts } from "@/lib/tiles/build";
import { insertLayer, updateMapFields, updateLayerFields, deleteLayer, reorderLayers,
  type Layer, type MapWithLayers } from "@/lib/metadata/maps";
import { undoSteps, redoSteps, setHistoryCursor, historyAvailability,
  type HistoryAvailability, type HistoryImage, type HistoryStep } from "@/lib/metadata/history";
import { requireMap, mapWithLayers } from "./map-access";

/** The map + fresh history availability — what undo/redo return, and what
 * the builder seeds its buttons from. */
export interface MapWithHistory extends MapWithLayers {
  history: HistoryAvailability;
}

export function mapHistory(id: string): HistoryAvailability {
  requireMap(id);
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

async function applyHistory(
  id: string,
  direction: "undo" | "redo",
): Promise<MapWithHistory> {
  requireMap(id);
  const steps = direction === "undo" ? undoSteps(id) : redoSteps(id);
  if (steps.length === 0) {
    throw new ApiError(
      "invalid_request",
      direction === "undo" ? "Nothing to undo." : "Nothing to redo.",
      409,
    );
  }
  const removedLayers: string[] = [];
  metadataDb().transaction(() => {
    for (const step of steps) applyStep(step, direction, removedLayers);
    const last = steps[steps.length - 1];
    setHistoryCursor(id, direction === "undo" ? last.seq - 1 : last.seq);
  })();
  await Promise.all(removedLayers.map((lid) => removeTileArtifacts(lid)));
  return { ...mapWithLayers(id), history: historyAvailability(id) };
}

/** Revert the newest step — or the whole group an assistant turn wrote. */
export function undoChange(id: string): Promise<MapWithHistory> {
  return applyHistory(id, "undo");
}

/** Re-apply the newest undone step (or group). */
export function redoChange(id: string): Promise<MapWithHistory> {
  return applyHistory(id, "redo");
}
