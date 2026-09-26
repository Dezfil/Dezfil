import { randomUUID } from "node:crypto";
import { metadataDb } from "@/lib/metadata/db";
import {
  getMap,
  deleteLayer,
  updateMapFields,
} from "@/lib/metadata/maps";
import { recordStep } from "@/lib/metadata/history";
import { removeTileArtifacts } from "@/lib/tiles/build";
import { requireLayer, layerImage } from "@/lib/layer-service";

/**
 * The layer deletion cascade, out of `layer-service.ts` (at-touch
 * decomposition slice — this is the piece touched).
 *
 * Delete a layer, recording it whole so an undo restores it in place.
 * Widgets bound to the layer go with it in the same undoable step: undo
 * restores layer and widgets together, redo removes both — no orphan is
 * ever stored. A manual legend arrangement loses the deleted layer's
 * slot in the same gesture, recorded with the cascade, so one undo
 * restores the layer and its place alike. Tile artifacts go with it; a
 * restore rebuilds them at render time — tile building is idempotent.
 */
export async function removeLayer(
  id: string,
  opts: { groupId?: string | null } = {},
): Promise<void> {
  const layer = requireLayer(id);
  const map = getMap(layer.mapId);
  const widgets = map?.widgets ?? [];
  const bound = widgets.filter((w) => w.layerId === id);
  const arrangement = map?.legendOrder ?? null;
  const arranged = arrangement?.includes(id) === true;
  metadataDb().transaction(() => {
    // A shared group makes the cascade one undo gesture.
    const groupId =
      bound.length || arranged
        ? (opts.groupId ?? randomUUID())
        : opts.groupId;
    if (bound.length) {
      const remaining = widgets.filter((w) => w.layerId !== id);
      updateMapFields(layer.mapId, { widgets: remaining });
      recordStep({
        mapId: layer.mapId,
        scope: "map",
        targetId: layer.mapId,
        op: "update",
        before: { widgets },
        after: { widgets: remaining },
        groupId,
      });
    }
    if (arrangement && arranged) {
      const pruned = arrangement.filter((lid) => lid !== id);
      updateMapFields(layer.mapId, {
        legendOrder: pruned.length ? pruned : null,
      });
      recordStep({
        mapId: layer.mapId,
        scope: "map",
        targetId: layer.mapId,
        op: "update",
        before: { legendOrder: arrangement },
        after: { legendOrder: pruned.length ? pruned : null },
        groupId,
      });
    }
    deleteLayer(id);
    recordStep({
      mapId: layer.mapId,
      scope: "layer",
      targetId: id,
      op: "delete",
      before: layerImage(layer),
      after: null,
      groupId,
    });
  })();
  await removeTileArtifacts(id);
}
