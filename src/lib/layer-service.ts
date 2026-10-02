import type { AccountScope } from "@/lib/auth/scope";
import type { UpdateLayerFields } from "./layer-admission";
import type { Layer } from "./metadata/maps";
import { ApiError } from "./api/errors";
import { deriveAndCommitUpdate } from "./layer-update";

export { requireLayer } from "./layer-access";
export { createLayer, duplicateLayer } from "./layer-creation";
export { layerImage } from "./layer-history-image";
export { fieldKind, layerFields, fieldsForWrite, baseFields, layerFieldStats, DISTRIBUTION_BINS,
  type FieldKind, type LayerField, type LayerFieldsResult, type FieldStats } from "./layer-fields";
export { renderLayer, type LayerRenderData, type LayerTiles, type LayerRenderGeometryType, type RenderLayerOpts } from "./layer-render";
export { liveRenderFilters, renderFilters } from "./layer-render-filters";
export { layerEffectiveSql, sliderPreviewData } from "./layer-preview";

export async function updateLayer(
  scope: AccountScope,
  id: string,
  fields: UpdateLayerFields,
  opts: { groupId?: string | null; signal?: AbortSignal } = {},
): Promise<Layer> {
  // The coupled adjustments below derive whole style/viz containers from a
  // snapshot while engine work yields; a concurrent write landing in that
  // window would be silently overwritten at commit. Re-derive against a
  // fresh snapshot until the commit's read matches the one the derivation
  // used — no accepted write is lost.
  for (let attempt = 0; attempt < 5; attempt++) {
    const applied = await deriveAndCommitUpdate(scope, id, fields, opts);
    if (applied) return applied;
  }
  // Practically unreachable: it needs a concurrent write landing inside
  // every derivation window, five times running. Refusing truthfully beats
  // committing stale derivations — and stays inside the documented error
  // catalog rather than minting a new code for a pathological path.
  throw new ApiError(
    "internal",
    "The layer kept changing while this save was settling; it was not applied.",
    500,
  );
}
