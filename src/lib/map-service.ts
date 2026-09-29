import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { removeTileArtifacts } from "@/lib/tiles/build";
import { removeThumbnail } from "@/lib/map-thumbnails";
import { invalidatePublishedToken } from "@/lib/publish/publish-service";
import { CORNERS, isCorner, type Corner } from "@/lib/corners";
import { isValidTimeline, TIMELINE_SPEED, type MapTimeline } from "@/lib/timeline";
import { isValidWidgets, MAX_WIDGETS, type MapWidget } from "@/lib/widgets";
import {
  refProblem,
  widgetRefs,
  type ColumnRef,
} from "@/lib/column-validation";
import { fieldsForWrite } from "@/lib/layer-service";
import { isAggregated } from "@/lib/viz";
import { representativeColor } from "@/lib/style/style";
import type { BasemapKey } from "@/lib/basemap";
import {
  BASEMAP_LAYER_GROUPS,
  isBasemapLayerGroup,
  type BasemapLayers,
} from "@/lib/basemap-layers";
import {
  insertMap,
  getMap,
  listMaps,
  updateMapFields,
  deleteMap,
  listLayers,
  insertLayer,
  updateLayerFields,
  deleteLayer,
  reorderLayers,
  type CustomBasemap,
  type Layer,
  type MapRecord,
  type MapWithLayers,
  type Viewport,
} from "@/lib/metadata/maps";
import {
  fileMap,
  mapProjectId,
  mapProjectIds,
  requireProject,
  touchProjectsOf,
} from "@/lib/metadata/projects";
import { metadataDb } from "@/lib/metadata/db";
import {
  recordStep,
  diffImages,
  stableJson,
  undoSteps,
  redoSteps,
  setHistoryCursor,
  historyAvailability,
  type HistoryAvailability,
  type HistoryImage,
  type HistoryStep,
} from "@/lib/metadata/history";

/** Map fields the timeline records. The viewport is deliberately
 * absent — one step per camera gesture would drown everything else. */
const RECORDED_MAP_FIELDS = [
  "name",
  "basemap",
  "customBasemap",
  "basemapLayers",
  "note",
  "legendCorner",
  "legendOrder",
  "timeline",
  "widgets",
  "widgetsPublished",
] as const;

/** Fresh maps open on the populated world: zoomed to ~1.3 and biased north
 * so the canvas clamp pins the view just under the top of the world —
 * Greenland to the Southern Ocean, no dead space above. */
const DEFAULT_VIEWPORT: Viewport = { lng: 0, lat: 40, zoom: 1.3 };

/**
 * Validate and normalize incoming basemap layer visibility. Only hidden
 * groups are kept — visible is the default — so an object with nothing
 * hidden normalizes to null, the same as every earlier map.
 */
function normalizeBasemapLayers(input: unknown): BasemapLayers | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiError(
      "invalid_request",
      "basemapLayers must be an object of group visibilities, or null to show everything.",
      400,
    );
  }
  const normalized: BasemapLayers = {};
  for (const [group, visible] of Object.entries(input)) {
    if (!isBasemapLayerGroup(group)) {
      throw new ApiError(
        "invalid_request",
        `Unknown basemap layer group "${group}"; the groups are ${BASEMAP_LAYER_GROUPS.join(", ")}.`,
        400,
      );
    }
    if (typeof visible !== "boolean") {
      throw new ApiError(
        "invalid_request",
        `basemapLayers.${group} must be true (visible) or false (hidden).`,
        400,
      );
    }
    if (!visible) normalized[group] = false;
  }
  return Object.keys(normalized).length ? normalized : null;
}

/**
 * Validate a timeline dock. The dock must point at a time filter that
 * actually exists on a non-aggregated layer of this map — hex/grid cells are
 * aggregated server-side, so there is nothing client-side for a playback
 * window to sweep. Everything is checked before anything is written. (Later
 * drift — the layer or filter going away — is tolerated on read: an
 * unresolvable dock simply renders as no timeline.)
 */
function normalizeTimeline(input: unknown, mapId: string): MapTimeline {
  if (!isValidTimeline(input)) {
    throw new ApiError(
      "invalid_request",
      "timeline must be { layerId, field, speed? }, speed between " +
        `${TIMELINE_SPEED.min} and ${TIMELINE_SPEED.max}, or null to undock.`,
      400,
    );
  }
  const layer = listLayers(mapId).find((l) => l.id === input.layerId);
  if (!layer) {
    throw new ApiError(
      "invalid_request",
      "timeline.layerId must be one of the map's layers.",
      400,
    );
  }
  if (isAggregated(layer.viz)) {
    throw new ApiError(
      "invalid_request",
      "Aggregated layers (hexbin/grid) cannot dock the timeline; their " +
        "time filter still applies, without playback.",
      400,
    );
  }
  const hasFilter = layer.filters.some(
    (f) => f.kind === "timerange" && f.field === input.field,
  );
  if (!hasFilter) {
    throw new ApiError(
      "invalid_request",
      `The layer needs a time filter on "${input.field}" before that field ` +
        "can dock the timeline.",
      400,
    );
  }
  return {
    layerId: input.layerId,
    field: input.field,
    speed: input.speed ?? TIMELINE_SPEED.default,
  };
}

/**
 * Validate an incoming widget list. Shape and cross-field rules live in the
 * widgets module; this adds author-time integrity — a caller may not
 * INTRODUCE a widget pointing at a layer the map does not own.
 *
 * Echoing drift that is already stored is tolerated, and that distinction
 * is the whole contract: removed every source of new orphans — deletion
 * cascades to bound widgets in one undoable step, duplication drops what it
 * cannot resolve, and the v21 migration swept the old ones — but replaying
 * an earlier layer-only delete step can still surface one transiently.
 * Refusing the echo would brick every widget write on that map ('s harm);
 * silently dropping it would lose an author's configuration that undoing
 * the same step is about to make whole again. Read lanes degrade a drifted
 * reference to absence, as they always have.
 */
function normalizeWidgets(input: unknown, mapId: string): MapWidget[] {
  if (!isValidWidgets(input)) {
    throw new ApiError(
      "invalid_request",
      "widgets must be a list of up to " +
        `${MAX_WIDGETS} widgets, each { id, type: formula | category | ` +
        "histogram | note, layerId, title, field, agg, aggField, unit, " +
        "note, format, visible } with unique ids and type-consistent " +
        "fields (notes carry layerId: null and a note body).",
      400,
    );
  }
  const owned = new Set(listLayers(mapId).map((l) => l.id));
  const stored = new Map(
    (getMap(mapId)?.widgets ?? []).map((w) => [w.id, w.layerId]),
  );
  for (const w of input) {
    // Notes read nothing and carry no layer.
    if (w.layerId !== null && !owned.has(w.layerId)) {
      // An unchanged echo of a reference already stored is not this
      // caller's error — see the contract above.
      if (stored.get(w.id) === w.layerId) continue;
      throw new ApiError(
        "invalid_request",
        `Widget "${w.title}" points at layer ${w.layerId}, which is not one ` +
          "of the map's layers.",
        400,
      );
    }
  }
  return input.map((w) => ({ ...w, title: w.title.trim() }));
}

/**
 * The map write's semantic gate: widget and timeline column references
 * a request introduces or changes must resolve against their bound
 * layer's result schema. The route awaits this before the synchronous
 * write below — `updateMap` itself stays sync, and shape, ownership and
 * dock-target rules stay where they are. Per-widget identity mirrors
 * the echo contract: a widget echoed with its reading tuple unchanged
 * is never retro-refused, however stale; a new or re-pointed one
 * validates.
 */
export async function validateMapWriteRefs(
  mapId: string,
  fields: { timeline?: unknown; widgets?: unknown },
  signal?: AbortSignal,
): Promise<void> {
  const map = getMap(mapId);
  if (!map) return; // the write itself answers 404
  const layers = new Map(listLayers(mapId).map((l) => [l.id, l]));
  const perLayer = new Map<string, ColumnRef[]>();
  const collect = (layerId: string, refs: ColumnRef[]) => {
    if (refs.length === 0 || !layers.has(layerId)) return;
    perLayer.set(layerId, [...(perLayer.get(layerId) ?? []), ...refs]);
  };
  if (fields.widgets !== undefined && isValidWidgets(fields.widgets)) {
    const stored = new Map((map.widgets ?? []).map((w) => [w.id, w]));
    for (const w of fields.widgets) {
      if (w.type === "note" || w.layerId === null) continue;
      const prior = stored.get(w.id);
      // The echo contract compares what the widget READS — its column
      // tuples — not its operation or presentation: avg→sum on the same
      // stranded field reads nothing new, so it echoes. Titles are stripped for the comparison — they name the
      // refusal, never the reference — and only the tuples this write
      // actually changes are validated, so an unchanged stranded tuple
      // rides alongside a changed one untouched.
      const bare = (x: typeof w) => widgetRefs({ ...x, title: "" });
      const titled = widgetRefs(w);
      const bareIn = bare(w);
      const prev =
        prior !== undefined && prior.layerId === w.layerId ? bare(prior) : [];
      const prevKeys = new Set(prev.map((r) => JSON.stringify(r)));
      collect(
        w.layerId,
        titled.filter((_, i) => !prevKeys.has(JSON.stringify(bareIn[i]))),
      );
    }
  }
  if (fields.timeline !== undefined && isValidTimeline(fields.timeline)) {
    const t = fields.timeline;
    const unchanged =
      map.timeline !== null &&
      map.timeline.layerId === t.layerId &&
      map.timeline.field === t.field;
    if (!unchanged) {
      collect(t.layerId, [
        { family: "filterable", needs: "time", name: t.field, channel: "timeline" },
      ]);
    }
  }
  for (const [layerId, refs] of perLayer) {
    const layer = layers.get(layerId)!;
    const problem = refProblem(
      refs,
      await fieldsForWrite(layer.sql, layer.viz, signal),
    );
    if (problem) throw new ApiError("column_unavailable", problem, 400);
  }
}

export function createMap(scope: AccountScope, name: string): MapRecord {
  requireAccountScope(scope);
  const now = new Date().toISOString();
  const map: MapRecord = {
    id: randomUUID(),
    name: name.trim() || "Untitled map",
    viewport: DEFAULT_VIEWPORT,
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  insertMap(scope, map);
  return map;
}

export function allMaps(): MapRecord[] {
  return listMaps();
}

/** A listed map plus what its card needs: how many layers it
 * has and one representative color per layer, in draw order — and, the
 * project it is in (null = not in one). The reference is deliberately
 * not on MapRecord, so the published snapshot's revision never observes
 * a membership change. */
export interface MapOverview extends MapRecord {
  projectId: string | null;
  layerCount: number;
  layerColors: string[];
}

function cssColor(c: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

export function mapsOverview(project?: string | "none"): MapOverview[] {
  // An unknown project refuses — a silently empty list would read as an
  // empty project.
  if (project && project !== "none") requireProject(project);
  const memberships = mapProjectIds();
  return listMaps()
    .map((m) => {
      const layers = listLayers(m.id);
      return {
        ...m,
        projectId: memberships.get(m.id) ?? null,
        layerCount: layers.length,
        layerColors: layers.map((l) => cssColor(representativeColor(l.style))),
      };
    })
    .filter((m) =>
      project === undefined
        ? true
        : project === "none"
          ? m.projectId === null
          : m.projectId === project,
    );
}

export function requireMap(id: string): MapRecord {
  const map = getMap(id);
  if (!map) throw new ApiError("not_found", `No map with id ${id}.`, 404);
  return map;
}

export function mapWithLayers(id: string): MapWithLayers {
  const map = requireMap(id);
  return { ...map, layers: listLayers(id) };
}

export function updateMap(
  id: string,
  fields: Partial<{
    name: string;
    viewport: Viewport;
    basemap: BasemapKey | null;
    /** Pre-inspected by the route — the service trusts it. */
    customBasemap: CustomBasemap | null;
    basemapLayers: unknown;
    legendCorner: unknown;
    legendOrder: unknown;
    timeline: unknown;
    widgets: unknown;
    widgetsPublished: unknown;
    layerOrder: string[];
  }>,
  opts: { groupId?: string | null } = {},
): MapWithLayers {
  const prior = requireMap(id);
  // Validate everything before writing anything — no partial writes.
  const basemapLayers =
    fields.basemapLayers === undefined
      ? undefined
      : fields.basemapLayers === null
        ? null
        : normalizeBasemapLayers(fields.basemapLayers);
  if (
    fields.legendCorner !== undefined &&
    fields.legendCorner !== null &&
    !isCorner(fields.legendCorner)
  ) {
    throw new ApiError(
      "invalid_request",
      `The legend corner must be one of ${CORNERS.join(", ")}, or null for bottom-left.`,
      400,
    );
  }
  const legendCorner = fields.legendCorner as Corner | null | undefined;
  // The manual legend arrangement: null returns the map to automatic;
  // anything else must name exactly the map's current layer ids — no
  // misses, no strangers, no doubles — or nothing changes.
  let legendOrder: string[] | null | undefined;
  if (fields.legendOrder === undefined) {
    legendOrder = undefined;
  } else if (fields.legendOrder === null) {
    legendOrder = null;
  } else {
    const arrangement = fields.legendOrder;
    const owned = new Set(listLayers(id).map((l) => l.id));
    if (
      !Array.isArray(arrangement) ||
      !arrangement.every((lid) => typeof lid === "string") ||
      arrangement.length !== owned.size ||
      !arrangement.every((lid) => owned.has(lid)) ||
      new Set(arrangement).size !== arrangement.length
    ) {
      throw new ApiError(
        "invalid_request",
        "legendOrder must list exactly the map's current layer ids, or null for the automatic order.",
        400,
      );
    }
    // An empty arrangement (a zero-layer map) is the automatic order.
    legendOrder = arrangement.length ? (arrangement as string[]) : null;
  }
  const timeline =
    fields.timeline === undefined
      ? undefined
      : fields.timeline === null
        ? null
        : normalizeTimeline(fields.timeline, id);
  const widgets =
    fields.widgets === undefined
      ? undefined
      : normalizeWidgets(fields.widgets, id);
  if (
    fields.widgetsPublished !== undefined &&
    typeof fields.widgetsPublished !== "boolean"
  ) {
    throw new ApiError(
      "invalid_request",
      "widgetsPublished must be true or false.",
      400,
    );
  }
  const widgetsPublished = fields.widgetsPublished as boolean | undefined;
  const priorOrder =
    fields.layerOrder !== undefined
      ? listLayers(id).map((l) => l.id)
      : null;
  if (priorOrder && fields.layerOrder !== undefined) {
    const owned = new Set(priorOrder);
    if (
      fields.layerOrder.length !== owned.size ||
      !fields.layerOrder.every((lid) => owned.has(lid))
    ) {
      throw new ApiError(
        "invalid_request",
        "layerOrder must list exactly the map's current layer ids.",
        400,
      );
    }
  }
  metadataDb().transaction(() => {
    if (
      fields.name !== undefined ||
      fields.viewport !== undefined ||
      fields.basemap !== undefined ||
      fields.customBasemap !== undefined ||
      basemapLayers !== undefined ||
      legendCorner !== undefined ||
      legendOrder !== undefined ||
      timeline !== undefined ||
      widgets !== undefined ||
      widgetsPublished !== undefined
    ) {
      updateMapFields(id, {
        name: fields.name,
        viewport: fields.viewport,
        basemap: fields.basemap,
        customBasemap: fields.customBasemap,
        basemapLayers,
        legendCorner,
        legendOrder,
        timeline,
        widgets,
        widgetsPublished,
      });
    }
    if (fields.layerOrder !== undefined) {
      reorderLayers(id, fields.layerOrder);
    }
    // Record what actually changed, as stored. The layer order is a
    // virtual field — it lives as ordinals on the layers.
    const fresh = getMap(id)!;
    const diff = diffImages(
      prior as unknown as Record<string, unknown>,
      fresh as unknown as Record<string, unknown>,
      [...RECORDED_MAP_FIELDS],
    );
    const before: HistoryImage = diff?.before ?? {};
    const after: HistoryImage = diff?.after ?? {};
    if (
      priorOrder &&
      fields.layerOrder !== undefined &&
      stableJson(priorOrder) !== stableJson(fields.layerOrder)
    ) {
      before.layerOrder = priorOrder;
      after.layerOrder = fields.layerOrder;
    }
    if (Object.keys(before).length) {
      recordStep({
        mapId: id,
        scope: "map",
        targetId: id,
        op: "update",
        before,
        after,
        groupId: opts.groupId,
      });
    }
  })();
  return mapWithLayers(id);
}

// undo / redo ----

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

/**
 * Duplicate a map whole: same viewport, basemap, note, legend, and layers
 * under fresh ids — an unpublished draft named "<name> copy". History
 * stays behind; a docked timeline follows its copied layer. Tiles rebuild
 * lazily for the new layer ids, like any new layer.
 */
export function duplicateMap(scope: AccountScope, id: string): MapWithLayers {
  requireAccountScope(scope);
  const source = requireMap(id);
  const layers = listLayers(id);
  const now = new Date().toISOString();
  const newId = randomUUID();
  metadataDb().transaction(() => {
    const layerIds = new Map<string, string>();
    insertMap(scope, {
      ...source,
      id: newId,
      name: `${source.name} copy`,
      // Remapped below once the copied layers have their ids — copied
      // verbatim it would name the source's layers.
      legendOrder: null,
      timeline: null,
      widgets: [],
      publishToken: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const layer of layers) {
      const layerId = randomUUID();
      layerIds.set(layer.id, layerId);
      insertLayer({
        ...layer,
        id: layerId,
        mapId: newId,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (source.timeline) {
      const dockedLayer = layerIds.get(source.timeline.layerId);
      if (dockedLayer) {
        updateMapFields(newId, {
          timeline: { ...source.timeline, layerId: dockedLayer },
        });
      }
    }
    // A manual legend arrangement follows its copied layers under their
    // fresh ids; ids that no longer resolve simply drop.
    if (source.legendOrder) {
      const remapped = source.legendOrder
        .map((lid) => layerIds.get(lid))
        .filter((lid): lid is string => lid !== undefined);
      if (remapped.length) {
        updateMapFields(newId, { legendOrder: remapped });
      }
    }
    // Widgets follow their copied layers under fresh ids; notes carry
    // no layer and copy as-is. A data widget whose layer cannot be
    // resolved is DROPPED, exactly as an unresolvable timeline dock is:
    // the copy has no history, so the undo that justified tolerating
    // the orphan cannot exist there — a stale id would be a permanent
    // cross-map reference that bricks every widget write.
    if (source.widgets.length) {
      const widgets = source.widgets
        .filter((w) => w.layerId === null || layerIds.has(w.layerId))
        .map((w) => ({
          ...w,
          id: randomUUID(),
          layerId: w.layerId ? (layerIds.get(w.layerId) ?? null) : null,
        }));
      if (widgets.length) updateMapFields(newId, { widgets });
    }
    // The copy lands in its source's project — read INSIDE this
    // transaction, so a move racing the copy cannot file it where the
    // source no longer is (found at review).
    const sourceProject = mapProjectId(id);
    if (sourceProject) fileMap(newId, sourceProject);
  })();
  return mapWithLayers(newId);
}

export async function removeMap(id: string): Promise<void> {
  const map = requireMap(id);
  const layerIds = listLayers(id).map((l) => l.id);
  // The set the map leaves must notice: the cascade removes nothing
  // here (the reference nulls), but the project's own clock advances.
  touchProjectsOf({ mapId: id });
  deleteMap(id); // layers (and their tile records) cascade
  if (map.publishToken) invalidatePublishedToken(map.publishToken);
  // Archives and thumbnails are files, not rows — remove them explicitly.
  await removeThumbnail(id);
  await Promise.all(layerIds.map((lid) => removeTileArtifacts(lid)));
}
