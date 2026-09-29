import { randomUUID } from "node:crypto";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { requireMap } from "./map-access";
import { requireLayer } from "./layer-access";
import { layerImage } from "./layer-history-image";
import { assertWritableRefs } from "./layer-write-refs";
import { inspectLayerGeometry } from "./layer-geometry";
import { metadataDb } from "@/lib/metadata/db";
import { insertLayer, updateMapFields, nextOrdinal, type Layer } from "@/lib/metadata/maps";
import { recordStep } from "@/lib/metadata/history";
import { styleProblem, normalizeStyle, type LayerStyle } from "@/lib/style/style";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import { styleRefs } from "@/lib/column-validation";

/** A new layer enters a manual legend arrangement at the top, durably
 * left unstored, its slot would re-derive from the panel on every render
 * and move when the panel does. Recorded in the add's own gesture, so
 * one undo removes layer and slot together. */
function enterArrangement(
  mapId: string,
  layerId: string,
  arrangement: string[],
  groupId: string | null | undefined,
): void {
  const next = [layerId, ...arrangement];
  updateMapFields(mapId, { legendOrder: next });
  recordStep({
    mapId,
    scope: "map",
    targetId: mapId,
    op: "update",
    before: { legendOrder: arrangement },
    after: { legendOrder: next },
    groupId,
  });
}

export async function createLayer(
  scope: AccountScope,
  mapId: string,
  input: { name: string; sql: string; style?: LayerStyle },
  opts: { groupId?: string | null; signal?: AbortSignal } = {},
): Promise<Layer> {
  requireMap(scope, mapId);
  const { geometryType } = await inspectLayerGeometry(scope, input.sql, opts.signal);
  if (input.style !== undefined) {
    const problem = styleProblem(input.style);
    if (problem) {
      throw new ApiError("invalid_request", `The style is not valid: ${problem}`, 400);
    }
    // A created layer has no stored config to echo: every reference the
    // style carries is introduced here and validates.
    await assertWritableRefs(scope,
      styleRefs(input.style),
      [],
      input.sql,
      POINTS_VIZ,
      opts.signal,
    );
  }
  const now = new Date().toISOString();
  const ordinal = nextOrdinal(mapId);
  const layer: Layer = {
    id: randomUUID(),
    mapId,
    name: input.name,
    sql: input.sql,
    // Default colors cycle by creation order (kepler defaults).
    style: input.style
      ? normalizeStyle(input.style)
      : defaultStyle(geometryType, ordinal),
    visible: true,
    tooltip: null,
    popup: null,
    publishedFields: null,
    inLegend: true,
    viz: POINTS_VIZ,
    filters: [],
    legendTitle: null,
    legendLabels: null,
    legendAttrs: null,
    ordinal,
    createdAt: now,
    updatedAt: now,
  };
  metadataDb().transaction(() => {
    const arrangement = requireMap(scope, mapId).legendOrder;
    layer.ordinal = nextOrdinal(mapId);
    const groupId = arrangement
      ? (opts.groupId ?? randomUUID())
      : opts.groupId;
    insertLayer(layer);
    recordStep({
      mapId,
      scope: "layer",
      targetId: layer.id,
      op: "add",
      before: null,
      after: layerImage(layer),
      groupId,
    });
    if (arrangement) enterArrangement(mapId, layer.id, arrangement, groupId);
  })();
  return layer;
}

/** Duplicate a layer in place: full copy — SQL, style, tooltip, legend flag —
 * with a suffixed name, stacked on top. */
export function duplicateLayer(
  scope: AccountScope,
  id: string,
  opts: { groupId?: string | null } = {},
): Layer {
  return metadataDb().transaction(() => {
    const source = requireLayer(scope, id);
    const now = new Date().toISOString();
    const copy: Layer = {
      ...source,
      id: randomUUID(),
      name: `${source.name} copy`,
      ordinal: nextOrdinal(source.mapId),
      createdAt: now,
      updatedAt: now,
    };
    const arrangement = requireMap(scope, source.mapId).legendOrder;
    const groupId = arrangement
      ? (opts.groupId ?? randomUUID())
      : opts.groupId;
    insertLayer(copy);
    recordStep({
      mapId: source.mapId,
      scope: "layer",
      targetId: copy.id,
      op: "add",
      before: null,
      after: layerImage(copy),
      groupId,
    });
    if (arrangement)
      enterArrangement(source.mapId, copy.id, arrangement, groupId);
    return copy;
  })();
}
