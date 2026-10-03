import { requireDocumentRevision } from "./metadata/revisions";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import type { Layer } from "@/lib/metadata/maps";
import {
  normalizeStyle,
  styleProblem,
  type LayerStyle,
} from "@/lib/style/style";
import {
  isAggregated,
  POINTS_VIZ,
  type LayerFilter,
  type LayerViz,
  type LegendAttrs,
} from "@/lib/viz";
import {
  filterRefs,
  listRefs,
  styleRefs,
  vizRefs,
  type ColumnRef,
} from "@/lib/column-validation";
import { requireLayerFor } from "./layer-access";
import { requireMapFor } from "./map-access";
import { assertWritableRefs } from "./layer-write-refs";
import { layerWriteChangesPublication } from "./publication-settings";
import { mapEvaluation } from "@/lib/query/context";
import { admitMapSql, recheckSaved, type SavedAdmission } from "./save-admission";

/**
 * The layer write admission: what a layer create or update must pass
 * before anything is derived from it, and the check its commit makes.
 * Out of `layer-service.ts` (and the create path beside it) under the
 * decomposition rule, with the same refusals, messages and order.
 *
 * Each entry first asks whether the acting account may change the layer's
 * map (the map named for a create, the layer's own map for an update): a
 * content change is the owner's, the project owner's or an editor's, and a
 * change to the published fields is the owner's alone. Then it validates
 * what the request introduces: SQL that draws geometry, a valid style, and
 * column references the resulting schema can honor. SQL someone other than
 * the map's owner saves must also name only datasets within their own reach
 * in the map's home (save-admission.ts), checked again at commit.
 */

/** What a layer update's admission bound, by the layer as admission read it,
 * for the commit's recheck. */
const updateAdmissions = new WeakMap<Layer, SavedAdmission>();

/** The layer when the acting account may make this write to it: an edit,
 * and the publish permission too when the published fields change. */
function permittedLayer(scope: AccountScope, id: string, fields: UpdateLayerFields): Layer {
  const layer = requireLayerFor(scope, id, "edit");
  if (layerWriteChangesPublication(layer, fields)) requireLayerFor(scope, id, "publish");
  return layer;
}

export type UpdateLayerFields = Partial<{
  name: string;
  sql: string;
  style: LayerStyle;
  visible: boolean;
  tooltip: string[] | null;
  popup: string[] | null;
  publishedFields: string[] | null;
  inLegend: boolean;
  viz: LayerViz;
  filters: LayerFilter[];
  legendTitle: string | null;
  legendLabels: (string | null)[] | null;
  legendAttrs: LegendAttrs | null;
}>;

/** A style is refused, with its problem named, before anything reads it. */
function assertValidStyle(style: LayerStyle): void {
  const problem = styleProblem(style);
  if (problem) {
    throw new ApiError("invalid_request", `The style is not valid: ${problem}`, 400);
  }
}

/** Admit a new layer on a map: the map under the acting scope, SQL that
 * yields a geometry, and a style (when one is given) that is valid and
 * whose references the result can honor. Returns the geometry the SQL
 * draws, which the default style follows. */
export async function admitLayerCreate(
  scope: AccountScope,
  mapId: string,
  input: { sql: string; style?: LayerStyle },
  signal?: AbortSignal,
): Promise<{ geometryType: string | null; saved: SavedAdmission }> {
  requireMapFor(scope, mapId, "edit");
  const saved = await admitMapSql(scope, mapId, input.sql, signal);
  const evaluation = mapEvaluation(scope, mapId);
  const { geometryType } = await inspectLayerGeometry(evaluation, input.sql, signal);
  if (input.style !== undefined) {
    assertValidStyle(input.style);
    // A created layer has no stored config to echo: every reference the
    // style carries is introduced here and validates.
    await assertWritableRefs(evaluation,
      styleRefs(input.style),
      [],
      input.sql,
      POINTS_VIZ,
      signal,
    );
  }
  return { geometryType, saved };
}

/** Admit an update to a layer: the layer, and with it its map, under the
 * acting scope; changed SQL that still yields a geometry; a valid style,
 * normalized; and every reference the request introduces or changes
 * resolving against the schema as the request leaves it. Returns the
 * layer as read at entry (the snapshot the commit compares against) and
 * the fields with the style normalized. */
export async function admitLayerUpdate(
  scope: AccountScope,
  id: string,
  fields: UpdateLayerFields,
  signal?: AbortSignal,
  expectedRevision?: unknown,
): Promise<{ layer: Layer; fields: UpdateLayerFields }> {
  const layer = permittedLayer(scope, id, fields);
  requireDocumentRevision(scope, { kind: "map", id: layer.mapId, expectedRevision });
  if (fields.sql !== undefined && fields.sql !== layer.sql) {
    updateAdmissions.set(layer, await admitMapSql(scope, layer.mapId, fields.sql, signal));
    // Editing SQL revalidates geometry, but the layer is not recreated.
    await inspectLayerGeometry(mapEvaluation(scope, layer.mapId), fields.sql, signal);
  }
  if (fields.style !== undefined) {
    assertValidStyle(fields.style);
    fields = { ...fields, style: normalizeStyle(fields.style) };
  }

  // Semantic validation: references this request introduces or changes
  // must resolve against the schema as the request leaves it. Stored
  // references echoed unchanged pass, and a SQL edit is never refused
  // for the references it strands — read-time degradation keeps covering
  // those. Runs before the derivations that follow admission so a bogus
  // reference refuses with the documented code instead of surfacing as an
  // engine error from derivation work.
  const nextViz = fields.viz ?? layer.viz;
  const incoming: ColumnRef[] = [];
  const stored: ColumnRef[] = [];
  if (fields.style !== undefined) {
    incoming.push(...styleRefs(fields.style));
    stored.push(...styleRefs(layer.style));
  }
  if (fields.viz !== undefined) {
    incoming.push(...vizRefs(fields.viz));
    stored.push(...vizRefs(layer.viz));
  }
  if (fields.filters !== undefined) {
    incoming.push(...filterRefs(fields.filters));
    stored.push(...filterRefs(layer.filters));
  }
  if (fields.tooltip !== undefined) {
    incoming.push(...listRefs(fields.tooltip, "styling", "tooltip"));
    stored.push(...listRefs(layer.tooltip, "styling", "tooltip"));
  }
  if (fields.popup !== undefined) {
    incoming.push(...listRefs(fields.popup, "styling", "pop-up"));
    stored.push(...listRefs(layer.popup, "styling", "pop-up"));
  }
  if (fields.publishedFields !== undefined) {
    incoming.push(
      ...listRefs(fields.publishedFields, "filterable", "published fields"),
    );
    stored.push(
      ...listRefs(layer.publishedFields, "filterable", "published fields"),
    );
  }
  // On an aggregated layer the label's attribute is dropped by the
  // normalization that follows admission, not stored — a reference that
  // will not survive the write is not validated.
  const validating = isAggregated(nextViz)
    ? incoming.filter((ref) => ref.channel !== "label")
    : incoming;
  await assertWritableRefs(mapEvaluation(scope, layer.mapId),
    validating,
    stored,
    fields.sql ?? layer.sql,
    nextViz,
    signal,
  );
  return { layer, fields };
}

/** The update's check at commit, inside its transaction: the permission is
 * asked again and the layer read again, and the write proceeds only while it
 * the map still has the revision admission read. A concurrent change refuses
 * the request whole; no derivation is repeated on a newer basis. */
export function admitLayerCommit(
  scope: AccountScope,
  id: string,
  entry: Layer,
  fields: UpdateLayerFields,
  expectedRevision?: unknown,
): Layer {
  const prior = permittedLayer(scope, id, fields);
  recheckSaved(scope, updateAdmissions.get(entry));
  requireDocumentRevision(scope, { kind: "map", id: entry.mapId, expectedRevision });
  return prior;
}
