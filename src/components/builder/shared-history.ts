import type { HistoryAvailability } from "@/lib/metadata/history";
import type { HistoryTarget } from "@/lib/history-targets";
import type { MapWithLayers } from "@/lib/metadata/maps";

export interface SharedHistory extends HistoryAvailability {
  editRevision?: string;
  undoTarget?: HistoryTarget | null;
  redoTarget?: HistoryTarget | null;
}
export function historyControl(history: SharedHistory, direction: "undo" | "redo", map?: MapWithLayers, stale = false) {
  const verb = direction === "undo" ? "Undo" : "Redo";
  const target = history[direction === "undo" ? "undoTarget" : "redoTarget"];
  const descriptions = target?.steps.map(step => {
    const actor = step.author ? `${step.author.name} (${step.author.sqlName})` : "Unknown";
    const name = step.scope === "map" ? map?.name ?? step.targetId : map?.layers.find(layer => layer.id === step.targetId)?.name ?? step.targetId;
    return `${actor} · ${name} · ${step.op}`;
  });
  return {
    action: [verb, ...new Set(descriptions), ...(target?.reason ? [target.reason] : [])].join(" · "),
    disabled: stale || !history[direction === "undo" ? "canUndo" : "canRedo"] || !target?.eligible,
  };
}
