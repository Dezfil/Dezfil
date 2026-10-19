import { notifyPicture } from "@/lib/pictures/hooks";
import { documentFacts, type DocumentFacts } from "./metadata/document-facts";
import { recordDocumentChanges, recordDocumentBatch, requireDocumentRevision } from "@/lib/metadata/revisions";
import { fileMap } from "@/lib/metadata/owned-projects";
import { assertMapLayerRefs } from "./map-layer-refs";
import { requireMapFor, mapWithLayersFor, ownMapWithLayers } from "./map-access";
import { mapWriteChangesPublication, requireLivePublicationChange } from "./publication-settings";
import { requireAllowedStyleAddress, requireOfferedBasemap, requireOfferedLibraryStyle } from "./basemap-rule";
export { requireMap, mapWithLayers, readMap, requireMapFor, mapWithLayersFor, requireOwnMap, ownMapWithLayers, ownsMap } from "./map-access";
export { mapHistory, undoChange, redoChange, type MapWithHistory } from "./map-history";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { canReach, mayFileInto, requireFilingDestination, requirePermitted, requireReachable } from "@/lib/auth/reach";
import { listReachableMaps } from "@/lib/metadata/map-queries";
import { mapPresencesOf, type Presence } from "@/lib/reach-presence";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { removeTileArtifacts } from "@/lib/tiles/build";
import type { DrawnBasemap } from "@/lib/picture-credit";
import { prepareThumbnailRemoval, servedThumbnails } from "@/lib/map-thumbnails";
import { invalidatePublishedToken } from "@/lib/publish/publish-service";
import { isValidTimeline } from "@/lib/timeline";
import { isValidWidgets } from "@/lib/widgets";
import {
  normalizeBasemapLayers,
  normalizeLegendOrder,
  normalizeTimeline,
  normalizeWidgets,
  requireLegendCorner,
  requireWidgetsPublished,
} from "@/lib/map-document-rules";
import {
  refProblem,
  widgetRefs,
  type ColumnRef,
} from "@/lib/column-validation";
import { fieldsForWrite } from "@/lib/layer-service";
import { representativeColor } from "@/lib/style/style";
import type { BasemapKey } from "@/lib/basemap";
import {
  insertMap,
  mapHome,
  getMap,
  updateMapFields,
  deleteMap,
  listLayers,
  insertLayer,
  reorderLayers,
  type CustomBasemap,
  type MapRecord,
  type MapWithLayers,
  type Viewport,
} from "@/lib/metadata/maps";
import {
  mapProjectId,
  touchProjectsOf,
} from "@/lib/metadata/projects";
import { metadataDb } from "@/lib/metadata/db";
import { instanceDefaults, type InstanceDefaults } from "@/lib/settings/defaults";
import { mapEvaluation } from "@/lib/query/context";
import {
  recordStep,
  diffImages,
  stableJson,
  type HistoryImage,
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

/** Where a new map opens, from the instance's defaults. The product's own
 * view opens on the populated world: zoomed to ~1.3 and biased north so
 * the canvas clamp pins the view just under the top of the world,
 * Greenland to the Southern Ocean, no dead space above. */
function startingView(defaults: InstanceDefaults): Viewport {
  return { lng: defaults["newMap.longitude"], lat: defaults["newMap.latitude"], zoom: defaults["newMap.zoom"] };
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
  scope: AccountScope,
  mapId: string,
  fields: { timeline?: unknown; widgets?: unknown; layerOrder?: unknown; legendOrder?: unknown },
  signal?: AbortSignal,
): Promise<void> {
  const map = requireMapFor(scope, mapId, "edit");
  const layers = new Map(listLayers(mapId).map((l) => [l.id, l]));
  assertMapLayerRefs(map, [...layers.values()], fields);
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
      await fieldsForWrite(mapEvaluation(scope, mapId), layer.sql, layer.viz, signal),
    );
    if (problem) throw new ApiError("column_unavailable", problem, 400);
  }
}

/** Every path that makes a map (the Maps screen, the API, the assistant,
 * the generated tools) comes through here, so each takes the instance's
 * defaults as they stand in the creating transaction. A basemap or legend
 * corner at the product's value resolves to unset and is stored as unset,
 * as every map before the defaults existed. */
export function createMap(scope: AccountScope, name: string, projectId: string | null = null): MapRecord & DocumentFacts {
  requireAccountScope(scope);
  if (projectId) requireFilingDestination(scope, projectId);
  const db = metadataDb();
  const created = db.transaction(() => {
  const defaults = instanceDefaults(db);
  const now = new Date().toISOString();
  const map: MapRecord = {
    id: randomUUID(),
    name: name.trim() || "Untitled map",
    viewport: startingView(defaults),
    basemap: defaults["newMap.basemap"],
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: defaults["newMap.legendCorner"],
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken: null,
    publishedAt: null,
    published: false,
    createdAt: now,
    updatedAt: now,
  };
  recordDocumentBatch(scope, () => {
    if (projectId) requireFilingDestination(scope, projectId);
    insertMap(scope, map);
    if (projectId) fileMap(scope, map.id, projectId, undefined, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  });
  return { ...map, ...documentFacts({ kind: "map", id: map.id }) };
  })();
  notifyPicture(created.id);
  return created;
}

/** Every map the acting account reaches. */
export function allMaps(scope: AccountScope): MapRecord[] {
  return listReachableMaps(scope).map((entry) => entry.map);
}

/** A listed map plus what its card needs: how many layers it
 * has and one representative color per layer, in draw order, whether it
 * has a card image the caller is served and the basemap that image was
 * drawn on (null when none was recorded) — and, the
 * project it is in (null = not in one), its owner and its SQL home. The
 * reference is deliberately not on MapRecord, so the published snapshot's
 * revision never observes a membership change. */
export interface MapOverview extends MapRecord, Presence, DocumentFacts {
  layerCount: number;
  layerColors: string[];
  hasThumbnail: boolean;
  thumbnailBasemap: DrawnBasemap | null;
}

function cssColor(c: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

/**
 * The maps the acting account reaches: its own and every map filed in a
 * project it owns or belongs to. `project` narrows to one reachable
 * project's maps, whoever owns them; `none` to the account's own maps that
 * are filed nowhere. One still filed in a project its owner no longer
 * reaches names that project and is not none.
 */
export async function mapsOverview(scope: AccountScope, project?: string | "none"): Promise<MapOverview[]> {
  const maps = listedMaps(scope, project);
  const pictured = await servedThumbnails(scope, maps.map((m) => m.id));
  // The picture reads await files, so access is checked again after them,
  // as an image read does: an account deactivated or a project left
  // meanwhile refuses as before, and a map no longer reached drops out.
  return metadataDb().transaction(() => {
    requireAccountScope(scope);
    if (project && project !== "none") requireReachable(scope, "project", project);
    return maps
      .filter((m) => canReach(scope, "map", m.id))
      .map((m) => ({ ...m, hasThumbnail: pictured.has(m.id), thumbnailBasemap: pictured.get(m.id) ?? null }));
  })();
}

function listedMaps(scope: AccountScope, project?: string | "none"): Omit<MapOverview, "hasThumbnail" | "thumbnailBasemap">[] {
  // An unknown or unreachable project refuses — a silently empty list
  // would read as an empty project.
  return metadataDb().transaction(() => {
  requireAccountScope(scope);
  if (project && project !== "none") requireReachable(scope, "project", project);
  const entries = listReachableMaps(scope);
  const presences = mapPresencesOf(scope, entries);
  return entries
    .map((entry, i) => {
      const layers = listLayers(entry.map.id);
      return {
        ...entry.map,
        ...documentFacts({ kind: "map", id: entry.map.id }),
        ...presences[i],
        layerCount: layers.length,
        layerColors: layers.map((l) => cssColor(representativeColor(l.style))),
      };
    })
    .filter((m, i) =>
      project === undefined
        ? true
        : project === "none"
          ? m.projectId === null && entries[i].ownerId === scope.accountId
          : m.projectId === project,
    );
  })();
}

export function updateMap(
  scope: AccountScope,
  id: string,
  fields: Partial<{
    name: string;
    viewport: Viewport;
    basemap: BasemapKey | null;
    /** Pre-inspected by the route — the service trusts it. */
    customBasemap: CustomBasemap | null;
    /** The library style `customBasemap` was copied from, by its id: asked
     * again inside the write, which refuses it hidden or removed meanwhile. */
    libraryStyle: string;
    basemapLayers: unknown;
    legendCorner: unknown;
    legendOrder: unknown;
    timeline: unknown;
    widgets: unknown;
    widgetsPublished: unknown;
    layerOrder: string[];
  }>,
  opts: { groupId?: string | null; expectedRevision?: unknown } = {},
): MapWithLayers & DocumentFacts {
  // Content is the editors' to change; the widget publication toggle is a
  // publication setting, the owner's alone, and on a live publication who
  // may publish decides it too.
  const prior = requireMapFor(scope, id, "edit");
  if (mapWriteChangesPublication(prior, fields)) { requireMapFor(scope, id, "publish"); requireLivePublicationChange(scope, id); }
  const covered = Object.entries(fields).some(([key, value]) => key !== "viewport" && value !== undefined);
  const checkRevision = () => { if (covered) requireDocumentRevision(scope, { kind: "map", id, expectedRevision: opts.expectedRevision }); };
  const storedLayers = listLayers(id);
  assertMapLayerRefs(prior, storedLayers, fields);
  checkRevision();
  // Validate everything before writing anything — no partial writes. The
  // rules are the map document's own (map-document-rules.ts), held against
  // the stored layers and, for the widget echo, the stored widgets.
  const storedLayerIds = storedLayers.map((l) => l.id);
  const basemapLayers =
    fields.basemapLayers === undefined
      ? undefined
      : fields.basemapLayers === null
        ? null
        : normalizeBasemapLayers(fields.basemapLayers);
  const legendCorner =
    fields.legendCorner === undefined
      ? undefined
      : requireLegendCorner(fields.legendCorner);
  const legendOrder =
    fields.legendOrder === undefined
      ? undefined
      : normalizeLegendOrder(fields.legendOrder, storedLayerIds);
  const timeline =
    fields.timeline === undefined
      ? undefined
      : fields.timeline === null
        ? null
        : normalizeTimeline(fields.timeline, storedLayers);
  const widgets =
    fields.widgets === undefined
      ? undefined
      : normalizeWidgets(fields.widgets, storedLayerIds, getMap(id)?.widgets ?? []);
  const widgetsPublished =
    fields.widgetsPublished === undefined
      ? undefined
      : requireWidgetsPublished(fields.widgetsPublished);
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
    const current = requireMapFor(scope, id, "edit");
    if (mapWriteChangesPublication(current, fields)) { requireMapFor(scope, id, "publish"); requireLivePublicationChange(scope, id); }
    checkRevision();
    // A basemap an admin hid is refused when this write would newly put it in
    // place, and so is a library style taken by its id that the library no
    // longer offers, and a style address this instance does not take now.
    requireOfferedBasemap(current.basemap, fields.basemap === undefined ? current.basemap : fields.basemap);
    if (fields.libraryStyle !== undefined) requireOfferedLibraryStyle(fields.libraryStyle);
    const held = current.customBasemap?.url ?? null;
    requireAllowedStyleAddress(held, fields.customBasemap === undefined ? held : fields.customBasemap?.url ?? null);
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
      recordDocumentChanges(scope, [{ kind: "map", id }]);
      recordStep({
        mapId: id,
        scope: "map",
        targetId: id,
        op: "update",
        before,
        after,
        groupId: opts.groupId,
      }, metadataDb(), scope);
    }
  })();
  notifyPicture(id);
  return mapWithLayersFor(scope, id, "edit");
}

/**
 * Duplicate a map whole: same viewport, basemap, note, legend, and layers
 * under fresh ids — an unpublished draft named "<name> copy". History
 * stays behind; a docked timeline follows its copied layer. Tiles rebuild
 * lazily for the new layer ids, like any new layer. A copy is not a new
 * map: it reads no instance default, so an unset basemap or legend corner
 * stays unset.
 *
 * Anyone who reaches the map may duplicate it, a frozen one included: the
 * copy is the duplicator's own, keeps the original's SQL home and its
 * layers' SQL as stored (so plain names still mean the home's datasets),
 * and lands in the original's project only when the duplicator may file
 * there (its owner or an editor); a viewer's copy is unfiled.
 */
function requireDuplicable(scope: AccountScope, id: string): MapRecord {
  requirePermitted(scope, "map", id, "duplicate");
  return getMap(id)!;
}

export function duplicateMap(scope: AccountScope, id: string): MapWithLayers & DocumentFacts {
  requireAccountScope(scope);
  const source = requireDuplicable(scope, id);
  const layers = listLayers(id);
  const now = new Date().toISOString();
  const newId = randomUUID();
  recordDocumentBatch(scope, () => {
    requireDuplicable(scope, id);
    const layerIds = new Map<string, string>();
    // The copy keeps its source's SQL home, whoever makes it.
    const home = mapHome(id) ?? undefined;
    // A copy keeps its source's basemap, hidden or not: the map is already on it.
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
      published: false,
      createdAt: now,
      updatedAt: now,
    }, metadataDb(), home);
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
    if (sourceProject && mayFileInto(scope, sourceProject)) fileMap(scope, newId, sourceProject, undefined, { expectedRevision: documentFacts({ kind: "map", id: newId }).editRevision });
  });
  return ownMapWithLayers(scope, newId);
}

export async function removeMap(scope: AccountScope, id: string, opts: { expectedRevision?: unknown } = {}): Promise<void> {
  const { map, layerIds, removeImages } = metadataDb().transaction(() => {
    const map = requireMapFor(scope, id, "delete");
    requireDocumentRevision(scope, { kind: "map", id, action: "delete", expectedRevision: opts.expectedRevision });
    const layerIds = listLayers(id).map((l) => l.id);
    // The set the map leaves must notice: the cascade removes nothing
    // here (the reference nulls), but the project's own clock advances.
    touchProjectsOf({ mapId: id });
    const removeImages = prepareThumbnailRemoval(scope, id);
    deleteMap(id); // layers (and their tile records) cascade
    return { map, layerIds, removeImages };
  })();
  if (map.publishToken) invalidatePublishedToken(map.publishToken);
  // Archives and thumbnails are files, not rows — remove them explicitly.
  await removeImages();
  await Promise.all(layerIds.map((lid) => removeTileArtifacts(lid)));
}
