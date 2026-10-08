import type { Database } from "better-sqlite3";
import { requireRule } from "@/lib/auth/instance-rules";
import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { stableJson, type HistoryStep } from "@/lib/metadata/history";
import { getMap, type Layer, type MapRecord } from "@/lib/metadata/maps";

/**
 * The publication settings: what a published link shows beyond the map's
 * content. The token, the theme and the reader controls change only through
 * the publish operations; the widget publication toggle and a layer's
 * published fields also travel through ordinary edits and history. All five
 * are the map owner's to change, so a write that would change one asks for
 * the publish permission as well as the edit permission.
 */

/**
 * Who may publish governs a live publication's settings too: while the map is
 * published, a write that changes one is refused when the instance's rule
 * excludes the acting account, as publishing it would be. A map that is not
 * published has no publication to change; publishing it is what the rule
 * decides then. Called beside the publish permission, inside the write.
 */
export function requireLivePublicationChange(scope: AccountScope, mapId: string, db: Database = metadataDb()): void {
  if (getMap(mapId, db)?.publishToken) requireRule(scope.accountId, "publishing.publish", db);
}

/** Whether a map write changes the widget publication toggle. */
export function mapWriteChangesPublication(map: MapRecord, fields: { widgetsPublished?: unknown }): boolean {
  return fields.widgetsPublished !== undefined && fields.widgetsPublished !== map.widgetsPublished;
}

/** Whether a layer write changes the layer's published fields. */
export function layerWriteChangesPublication(layer: Pick<Layer, "publishedFields">, fields: { publishedFields?: unknown }): boolean {
  return fields.publishedFields !== undefined && stableJson(fields.publishedFields) !== stableJson(layer.publishedFields);
}

/** Whether replaying these steps, in this direction, changes a publication
 * setting: a map image carrying a different widget toggle, or a layer update
 * carrying different published fields. Restoring or removing a whole layer is
 * content, its own published fields riding with it. */
export function historyChangesPublication(map: MapRecord, layers: Layer[], steps: HistoryStep[],
  direction: "undo" | "redo"): boolean {
  let widgetsPublished: unknown = map.widgetsPublished;
  const published = new Map(layers.map(layer => [layer.id, layer.publishedFields as unknown]));
  for (const step of steps) {
    const image = direction === "undo" ? step.before : step.after;
    if (!image || step.op !== "update") {
      if (step.scope === "layer" && image) published.set(step.targetId, image.publishedFields ?? null);
      continue;
    }
    if (step.scope === "map" && "widgetsPublished" in image) {
      if (image.widgetsPublished !== widgetsPublished) return true;
      widgetsPublished = image.widgetsPublished;
    }
    if (step.scope === "layer" && "publishedFields" in image) {
      if (stableJson(image.publishedFields ?? null) !== stableJson(published.get(step.targetId) ?? null)) return true;
      published.set(step.targetId, image.publishedFields ?? null);
    }
  }
  return false;
}
