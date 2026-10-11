import { ApiError } from "@/lib/api/errors";
import { isBasemapKey, type BasemapKey } from "@/lib/basemap";
import {
  BASEMAP_LAYER_GROUPS,
  isBasemapLayerGroup,
  type BasemapLayers,
} from "@/lib/basemap-layers";
import { cameraBoundsProblem } from "@/lib/camera-bounds";
import { CORNERS, isCorner, type Corner } from "@/lib/corners";
import type { Viewport } from "@/lib/metadata/maps";
import { isValidTimeline, TIMELINE_SPEED, type MapTimeline } from "@/lib/timeline";
import { isAggregated, type LayerFilter, type LayerViz } from "@/lib/viz";
import { isValidWidgets, MAX_WIDGETS, type MapWidget } from "@/lib/widgets";

/**
 * The map document's rules: what a map's own fields must be, taking the
 * document and its layers as values. The map write applies them to a
 * request against the stored layers; a document that never was a stored
 * map (one read from an archive) is held to the same rules against its own
 * layers, so a client's write and a document read from elsewhere cannot be
 * admitted by two rule sets that drift apart.
 */

/** What a rule needs to know of a layer of the map. */
export interface DocumentLayer {
  id: string;
  viz: LayerViz;
  filters: LayerFilter[];
}

/** A camera: { lng, lat, zoom } with optional pitch and bearing, inside the
 * bounds a submitted camera must keep. Omitted pitch and bearing mean flat
 * and north-up: one whole camera. */
export function normalizeViewport(input: unknown): Viewport {
  const v = input as Record<string, unknown>;
  if (
    !v ||
    typeof v.lng !== "number" ||
    typeof v.lat !== "number" ||
    typeof v.zoom !== "number"
  ) {
    throw new ApiError(
      "invalid_request",
      "viewport must be { lng, lat, zoom } with optional pitch and bearing.",
      400,
    );
  }
  const cameraProblem = cameraBoundsProblem(v);
  if (cameraProblem) throw new ApiError("invalid_request", cameraProblem, 400);
  if (
    v.bearing !== undefined &&
    (typeof v.bearing !== "number" || v.bearing < -360 || v.bearing > 360)
  ) {
    throw new ApiError(
      "invalid_request",
      "viewport.bearing must be a number of degrees, -360 to 360.",
      400,
    );
  }
  return {
    lng: v.lng,
    lat: v.lat,
    zoom: v.zoom,
    pitch: (v.pitch as number | undefined) ?? 0,
    bearing: (v.bearing as number | undefined) ?? 0,
  };
}

/** A basemap key, or null for the deployment default. */
export function requireBasemapKey(input: unknown): BasemapKey | null {
  if (input !== null && !isBasemapKey(input)) {
    throw new ApiError(
      "invalid_request",
      "basemap must be one of dark, light, streets, satellite, or null for the deployment default.",
      400,
    );
  }
  return input as BasemapKey | null;
}

/**
 * Validate and normalize incoming basemap layer visibility. Only hidden
 * groups are kept — visible is the default — so an object with nothing
 * hidden normalizes to null, the same as every earlier map.
 */
export function normalizeBasemapLayers(input: unknown): BasemapLayers | null {
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

/** A legend corner, or null for bottom-left. */
export function requireLegendCorner(input: unknown): Corner | null {
  if (input !== null && !isCorner(input)) {
    throw new ApiError(
      "invalid_request",
      `The legend corner must be one of ${CORNERS.join(", ")}, or null for bottom-left.`,
      400,
    );
  }
  return input as Corner | null;
}

/** The manual legend arrangement: null returns the map to automatic;
 * anything else must name exactly the map's layer ids — no misses, no
 * strangers, no doubles — or nothing changes. An empty arrangement (a
 * zero-layer map) is the automatic order. */
export function normalizeLegendOrder(
  input: unknown,
  layerIds: readonly string[],
): string[] | null {
  if (input === null) return null;
  const owned = new Set(layerIds);
  if (
    !Array.isArray(input) ||
    !input.every((lid) => typeof lid === "string") ||
    input.length !== owned.size ||
    !input.every((lid) => owned.has(lid)) ||
    new Set(input).size !== input.length
  ) {
    throw new ApiError(
      "invalid_request",
      "legendOrder must list exactly the map's current layer ids, or null for the automatic order.",
      400,
    );
  }
  return input.length ? (input as string[]) : null;
}

/**
 * Validate a timeline dock. The dock must point at a time filter that
 * actually exists on a non-aggregated layer of this map — hex/grid cells are
 * aggregated server-side, so there is nothing client-side for a playback
 * window to sweep. Everything is checked before anything is written. (Later
 * drift — the layer or filter going away — is tolerated on read: an
 * unresolvable dock simply renders as no timeline.)
 */
export function normalizeTimeline(
  input: unknown,
  layers: readonly DocumentLayer[],
): MapTimeline {
  if (!isValidTimeline(input)) {
    throw new ApiError(
      "invalid_request",
      "timeline must be { layerId, field, speed? }, speed between " +
        `${TIMELINE_SPEED.min} and ${TIMELINE_SPEED.max}, or null to undock.`,
      400,
    );
  }
  const layer = layers.find((l) => l.id === input.layerId);
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
 * reference to absence, as they always have. A document with nothing
 * stored passes no stored widgets, so every widget must name a layer.
 */
export function normalizeWidgets(
  input: unknown,
  layerIds: readonly string[],
  storedWidgets: readonly MapWidget[] = [],
): MapWidget[] {
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
  const owned = new Set(layerIds);
  const stored = new Map(storedWidgets.map((w) => [w.id, w.layerId]));
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

/** Whether widgets ship with the published view: true or false. */
export function requireWidgetsPublished(input: unknown): boolean {
  if (typeof input !== "boolean") {
    throw new ApiError(
      "invalid_request",
      "widgetsPublished must be true or false.",
      400,
    );
  }
  return input;
}
