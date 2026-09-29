import type { AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { metadataDb } from "@/lib/metadata/db";
import { listLayers, type Layer } from "@/lib/metadata/maps";
import type { HistoryStep } from "@/lib/metadata/history";
import { requireMap } from "./map-access";
import { assertMapLayerRefs } from "./map-layer-refs";

/** Simulate the complete gesture before replay writes anything. Restored rows
 * retain their recorded identity and parent; a live foreign row is never a
 * replacement target, even when a history image claims the current map. */
export function assertHistoryRefs(scope: AccountScope, mapId: string,
  steps: HistoryStep[], direction: "undo" | "redo"): void {
  let map = requireMap(scope, mapId);
  const layers = new Map(listLayers(mapId).map(layer => [layer.id, layer]));
  const removed = new Set<string>();
  for (const step of steps) {
    if (step.mapId !== mapId || !["update", "add", "delete"].includes(step.op)) throw resourceAbsent();
    const image = direction === "undo" ? step.before : step.after;
    if (step.scope === "map") {
      if (step.targetId !== mapId || step.op !== "update" || !image) throw resourceAbsent();
      assertMapLayerRefs(map, [...layers.values()], image);
      map = { ...map, ...image };
      continue;
    }
    if (step.scope !== "layer") throw resourceAbsent();
    if (step.op === "update") {
      const layer = layers.get(step.targetId);
      if (!layer || !image || (image.id !== undefined && image.id !== step.targetId) ||
        (image.mapId !== undefined && image.mapId !== mapId)) throw resourceAbsent();
      layers.set(step.targetId, { ...layer, ...image });
    } else if ((step.op === "add") === (direction === "undo")) {
      if (!layers.has(step.targetId)) throw resourceAbsent();
      layers.delete(step.targetId);
      removed.add(step.targetId);
    } else {
      if (!image || image.id !== step.targetId || image.mapId !== mapId) throw resourceAbsent();
      const existing = metadataDb().prepare("SELECT id FROM layers WHERE id = ?").get(step.targetId);
      if (layers.has(step.targetId) || (existing && !removed.has(step.targetId))) throw resourceAbsent();
      layers.set(step.targetId, image as unknown as Layer);
      removed.delete(step.targetId);
    }
  }
}
