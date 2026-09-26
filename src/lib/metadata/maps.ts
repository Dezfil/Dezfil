import { recoverCamera } from "@/lib/camera-bounds";
import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { normalizeStyle, type LayerStyle } from "@/lib/style/style";
import {
  normalizeViz,
  POINTS_VIZ,
  type LayerFilter,
  type LayerViz,
  type LegendAttrs,
} from "@/lib/viz";
import type { AttributionLine, BasemapKey } from "@/lib/basemap";

/** A per-map custom basemap style. The attribution snapshot
 * is captured server-side at save time — the credit that stays truthful
 * when the style itself cannot be read later. */
export interface CustomBasemap {
  url: string;
  /** Display name for the picker tile; null shows the URL's hostname. */
  name: string | null;
  attribution: AttributionLine[];
}
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { Corner } from "@/lib/corners";
import type { MapTimeline } from "@/lib/timeline";
import { normalizeWidget, type MapWidget } from "@/lib/widgets";

export interface Viewport {
  lng: number;
  lat: number;
  zoom: number;
  /** Camera tilt in degrees; absent reads as 0 — flat. */
  pitch?: number;
  /** Camera rotation in degrees; absent reads as 0 — north-up. */
  bearing?: number;
}

export interface Layer {
  id: string;
  mapId: string;
  name: string;
  sql: string;
  style: LayerStyle;
  visible: boolean;
  /** Fields shown in the hover tooltip; null = automatic (first few). */
  tooltip: string[] | null;
  /** Fields shown in the click pop-up; null = automatic — independent of
   * the tooltip so the two can differ. */
  popup: string[] | null;
  /** The author's explicit published-field list; null = the
   * derived minimal projection. The functional core always publishes. */
  publishedFields: string[] | null;
  /** Whether the layer contributes to the map legend. */
  inLegend: boolean;
  /** How the result is drawn: points (raw), hexbin/grid (aggregated), heatmap. */
  viz: LayerViz;
  /** Structured refinements of the result; SQL stays the source of truth. */
  filters: LayerFilter[];
  /** Legend title override; null = the layer name. */
  legendTitle: string | null;
  /** Per-entry legend label overrides; null = all automatic. */
  legendLabels: (string | null)[] | null;
  /** Per-channel legend attribute-name overrides; null = all automatic. */
  legendAttrs: LegendAttrs | null;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
}

export type NoteCorner = Corner;

/** The map's one optional note: shown as a floating box on the
 * builder canvas and the published view. */
export interface MapNote {
  /** Optional heading above the body. */
  title: string | null;
  /** The text, in the safe formatting subset. */
  body: string;
  corner: NoteCorner;
}

/** The published view's authored default theme. Deliberately
 * NOT a MapRecord field: ordinary map APIs return records whole and
 * duplication spreads them, so keeping the theme off the record confines
 * it to the publish and published-view contracts by construction. */
export type PublishedTheme = "light" | "dark";

/** Which optional reader controls an active publication exposes (spec
 * Zoom and point-north are never listed: a published map a reader
 * cannot navigate reads as broken, so they are not the author's to remove.
 * Publication-only state for the same reason as PublishedTheme above — off
 * MapRecord, so no ordinary map API or duplication can carry it. */
export interface ViewerControls {
  /** The 3D tilt toggle. */
  tilt: boolean;
  /** The fit-to-data button. */
  fit: boolean;
  /** The reader's light/dark toggle. */
  theme: boolean;
  /** The basemap picker. */
  basemap: boolean;
  /** The cursor coordinate readout in the attribution strip. */
  coords: boolean;
}

/** Every control on: a publication that states nothing, and every
 * publication made before 0077. The one place the default is decided. */
export const ALL_VIEWER_CONTROLS: ViewerControls = {
  tilt: true,
  fit: true,
  theme: true,
  basemap: true,
  coords: true,
};

/** Normalize a stated or stored control set. A stated setting fills its
 * omitted members with enabled; null — never published with one, or
 * published — reads as every control on. Unknown keys and non-boolean
 * values are ignored rather than trusted. */
export function normalizeViewerControls(
  value: Partial<ViewerControls> | null | undefined,
): ViewerControls {
  if (!value) return { ...ALL_VIEWER_CONTROLS };
  const pick = (key: keyof ViewerControls) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : true;
  return {
    tilt: pick("tilt"),
    fit: pick("fit"),
    theme: pick("theme"),
    basemap: pick("basemap"),
    coords: pick("coords"),
  };
}

export interface MapRecord {
  id: string;
  name: string;
  viewport: Viewport;
  /** Chosen basemap; null = deployment default. */
  basemap: BasemapKey | null;
  /** Custom basemap style; null = none. When set it wins
   * over the key, which it never touches. */
  customBasemap: CustomBasemap | null;
  /** Hidden basemap content groups; null = all visible (every earlier map). */
  basemapLayers: BasemapLayers | null;
  /** The map's note; null = no box (every earlier map). */
  note: MapNote | null;
  /** Where the legend sits; null = bottom-left (every earlier map). */
  legendCorner: Corner | null;
  /** The manual legend arrangement: layer ids in legend
   * order, top first; null = automatic — follow the layer panel (every
   * earlier map). */
  legendOrder: string[] | null;
  /** The docked playback timeline; null = none (every earlier map). */
  timeline: MapTimeline | null;
  /** Ordered widget list; empty for every earlier map. */
  widgets: MapWidget[];
  /** Whether widgets ship with the published view. */
  widgetsPublished: boolean;
  publishToken: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MapWithLayers extends MapRecord {
  layers: Layer[];
}

interface MapRow {
  id: string;
  name: string;
  view_lng: number;
  view_lat: number;
  view_zoom: number;
  view_pitch: number;
  view_bearing: number;
  basemap: string | null;
  custom_basemap: string | null;
  basemap_layers: string | null;
  note: string | null;
  legend_corner: string | null;
  legend_order: string | null;
  timeline: string | null;
  widgets: string | null;
  widgets_published: 0 | 1;
  publish_token: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LayerRow {
  id: string;
  map_id: string;
  name: string;
  sql: string;
  style: string;
  visible: 0 | 1;
  tooltip: string | null;
  popup: string | null;
  published_fields: string | null;
  in_legend: 0 | 1;
  viz: string | null;
  filters: string | null;
  legend_title: string | null;
  legend_labels: string | null;
  legend_attrs: string | null;
  ordinal: number;
  created_at: string;
  updated_at: string;
}

function mapFromRow(r: MapRow): MapRecord {
  return {
    id: r.id,
    name: r.name,
    viewport: recoverCamera({
      lng: r.view_lng,
      lat: r.view_lat,
      zoom: r.view_zoom,
      pitch: r.view_pitch ?? 0,
      bearing: r.view_bearing ?? 0,
    }),
    basemap: (r.basemap as BasemapKey | null) ?? null,
    customBasemap: r.custom_basemap
      ? (JSON.parse(r.custom_basemap) as CustomBasemap)
      : null,
    basemapLayers: r.basemap_layers
      ? (JSON.parse(r.basemap_layers) as BasemapLayers)
      : null,
    note: r.note ? (JSON.parse(r.note) as MapNote) : null,
    legendCorner: (r.legend_corner as Corner | null) ?? null,
    legendOrder: r.legend_order
      ? (JSON.parse(r.legend_order) as string[])
      : null,
    timeline: r.timeline ? (JSON.parse(r.timeline) as MapTimeline) : null,
    // Earlier rows (and SQL-migrated notes) normalize the newer fields.
    widgets: r.widgets
      ? (JSON.parse(r.widgets) as MapWidget[]).map(normalizeWidget)
      : [],
    widgetsPublished: r.widgets_published === 1,
    publishToken: r.publish_token,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function layerFromRow(r: LayerRow): Layer {
  return {
    id: r.id,
    mapId: r.map_id,
    name: r.name,
    sql: r.sql,
    // Styles persisted lack the newer fields; normalize on read.
    style: normalizeStyle(JSON.parse(r.style)),
    visible: r.visible === 1,
    tooltip: r.tooltip ? (JSON.parse(r.tooltip) as string[]) : null,
    popup: r.popup ? (JSON.parse(r.popup) as string[]) : null,
    publishedFields: r.published_fields
      ? (JSON.parse(r.published_fields) as string[])
      : null,
    inLegend: r.in_legend === 1,
    // Pre-raw points, no filters, automatic legend text. Earlier hex bins
    // carry an H3 resolution; normalize on read.
    viz: r.viz ? normalizeViz(JSON.parse(r.viz) as LayerViz) : POINTS_VIZ,
    filters: r.filters ? (JSON.parse(r.filters) as LayerFilter[]) : [],
    legendTitle: r.legend_title,
    legendLabels: r.legend_labels
      ? (JSON.parse(r.legend_labels) as (string | null)[])
      : null,
    legendAttrs: r.legend_attrs
      ? (JSON.parse(r.legend_attrs) as LegendAttrs)
      : null,
    ordinal: r.ordinal,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- maps ----

export function insertMap(m: MapRecord, db: Database = metadataDb()): void {
  db.prepare(
    `INSERT INTO maps
       (id, name, view_lng, view_lat, view_zoom, view_pitch, view_bearing, basemap, custom_basemap, basemap_layers, note, legend_corner, legend_order, timeline, widgets, widgets_published, publish_token, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.name,
    m.viewport.lng,
    m.viewport.lat,
    m.viewport.zoom,
    m.viewport.pitch ?? 0,
    m.viewport.bearing ?? 0,
    m.basemap,
    m.customBasemap ? JSON.stringify(m.customBasemap) : null,
    m.basemapLayers ? JSON.stringify(m.basemapLayers) : null,
    m.note ? JSON.stringify(m.note) : null,
    m.legendCorner,
    m.legendOrder ? JSON.stringify(m.legendOrder) : null,
    m.timeline ? JSON.stringify(m.timeline) : null,
    m.widgets.length ? JSON.stringify(m.widgets) : null,
    m.widgetsPublished ? 1 : 0,
    m.publishToken,
    m.publishedAt,
    m.createdAt,
    m.updatedAt,
  );
}

export function listMaps(db: Database = metadataDb()): MapRecord[] {
  // Most recent first: the maps screen reads in this order.
  return (
    db.prepare(`SELECT * FROM maps ORDER BY created_at DESC`).all() as MapRow[]
  ).map(mapFromRow);
}

export function getMap(id: string, db: Database = metadataDb()): MapRecord | null {
  const row = db.prepare(`SELECT * FROM maps WHERE id = ?`).get(id) as
    | MapRow
    | undefined;
  return row ? mapFromRow(row) : null;
}

export function getMapByToken(
  token: string,
  db: Database = metadataDb(),
): MapRecord | null {
  const row = db
    .prepare(`SELECT * FROM maps WHERE publish_token = ?`)
    .get(token) as MapRow | undefined;
  return row ? mapFromRow(row) : null;
}

/** Read a published map and its ordered layers from one SQLite snapshot.
 * Callers use the serialized value as a cheap durable revision: unlike
 * updated_at alone, it also observes reorder operations and delete/restore
 * cycles that can retain the same ids. The authored theme rides the
 * snapshot and is part of the revision, so an in-place theme update
 * retires cached published payloads immediately.
 *
 * Every publication-only field must be added to the revision tuple by
 * hand: the map half is a normalized MapRecord, not a row passthrough, so
 * a new column is invisible to it. The viewer controls join for exactly
 * that reason — without the tuple entry a changed checklist would serve
 * stale for the whole freshness bound. */
export function getPublishedSnapshot(
  token: string,
  db: Database = metadataDb(),
): {
  map: MapRecord;
  layers: Layer[];
  publishedTheme: PublishedTheme | null;
  viewerControls: ViewerControls | null;
  revision: string;
} | null {
  return db.transaction(() => {
    const map = getMapByToken(token, db);
    if (!map) return null;
    const layers = listLayers(map.id, db);
    const publishedTheme = getPublishedTheme(map.id, db);
    const viewerControls = getViewerControls(map.id, db);
    return {
      map,
      layers,
      publishedTheme,
      viewerControls,
      revision: JSON.stringify([
        map,
        layers,
        publishedTheme,
        viewerControls,
      ]),
    };
  })();
}

/** The authored published theme; null reads as dark. */
export function getPublishedTheme(
  id: string,
  db: Database = metadataDb(),
): PublishedTheme | null {
  const row = db
    .prepare(`SELECT published_theme FROM maps WHERE id = ?`)
    .get(id) as { published_theme: string | null } | undefined;
  return (row?.published_theme as PublishedTheme | null) ?? null;
}

/** The authored published theme by token — the published
 * page's server-side pre-paint read. Unknown tokens read null (dark);
 * the client fetch owns the 404 presentation. */
export function getPublishedThemeByToken(
  token: string,
  db: Database = metadataDb(),
): PublishedTheme | null {
  const row = db
    .prepare(`SELECT published_theme FROM maps WHERE publish_token = ?`)
    .get(token) as { published_theme: string | null } | undefined;
  return (row?.published_theme as PublishedTheme | null) ?? null;
}

/** Write the authored published theme. Publish-lifecycle callers only —
 * the field is not reachable through updateMapFields, so no ordinary map
 * edit can touch it. */
export function setPublishedTheme(
  id: string,
  theme: PublishedTheme | null,
  db: Database = metadataDb(),
): void {
  db.prepare(`UPDATE maps SET published_theme = ?, updated_at = ? WHERE id = ?`)
    .run(theme, new Date().toISOString(), id);
}

/** The active publication's stated viewer controls; null when
 * none was ever stated — which normalizes to every control on. Stored
 * text that no longer parses degrades to null rather than throwing: a
 * published page must keep rendering. */
export function getViewerControls(
  id: string,
  db: Database = metadataDb(),
): ViewerControls | null {
  const row = db
    .prepare(`SELECT viewer_controls FROM maps WHERE id = ?`)
    .get(id) as { viewer_controls: string | null } | undefined;
  if (!row?.viewer_controls) return null;
  try {
    return normalizeViewerControls(
      JSON.parse(row.viewer_controls) as Partial<ViewerControls>,
    );
  } catch {
    return null;
  }
}

/** Write the active publication's viewer controls. Publish-lifecycle
 * callers only, like the theme above — unreachable from updateMapFields,
 * so no ordinary map edit can touch it. */
export function setViewerControls(
  id: string,
  controls: ViewerControls | null,
  db: Database = metadataDb(),
): void {
  db.prepare(`UPDATE maps SET viewer_controls = ?, updated_at = ? WHERE id = ?`)
    .run(controls ? JSON.stringify(controls) : null, new Date().toISOString(), id);
}

export function updateMapFields(
  id: string,
  fields: Partial<{
    name: string;
    viewport: Viewport;
    basemap: BasemapKey | null;
    customBasemap: CustomBasemap | null;
    basemapLayers: BasemapLayers | null;
    note: MapNote | null;
    legendCorner: Corner | null;
    legendOrder: string[] | null;
    timeline: MapTimeline | null;
    widgets: MapWidget[];
    widgetsPublished: boolean;
    publishToken: string | null;
    publishedAt: string | null;
  }>,
  db: Database = metadataDb(),
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    values.push(fields.name);
  }
  if (fields.note !== undefined) {
    sets.push("note = ?");
    values.push(fields.note ? JSON.stringify(fields.note) : null);
  }
  if (fields.viewport !== undefined) {
    sets.push(
      "view_lng = ?",
      "view_lat = ?",
      "view_zoom = ?",
      "view_pitch = ?",
      "view_bearing = ?",
    );
    values.push(
      fields.viewport.lng,
      fields.viewport.lat,
      fields.viewport.zoom,
      fields.viewport.pitch ?? 0,
      fields.viewport.bearing ?? 0,
    );
  }
  if (fields.basemap !== undefined) {
    sets.push("basemap = ?");
    values.push(fields.basemap);
  }
  if (fields.customBasemap !== undefined) {
    sets.push("custom_basemap = ?");
    values.push(
      fields.customBasemap ? JSON.stringify(fields.customBasemap) : null,
    );
  }
  if (fields.basemapLayers !== undefined) {
    sets.push("basemap_layers = ?");
    values.push(
      fields.basemapLayers ? JSON.stringify(fields.basemapLayers) : null,
    );
  }
  if (fields.legendCorner !== undefined) {
    sets.push("legend_corner = ?");
    values.push(fields.legendCorner);
  }
  if (fields.legendOrder !== undefined) {
    sets.push("legend_order = ?");
    values.push(fields.legendOrder ? JSON.stringify(fields.legendOrder) : null);
  }
  if (fields.timeline !== undefined) {
    sets.push("timeline = ?");
    values.push(fields.timeline ? JSON.stringify(fields.timeline) : null);
  }
  if (fields.widgets !== undefined) {
    sets.push("widgets = ?");
    values.push(fields.widgets.length ? JSON.stringify(fields.widgets) : null);
  }
  if (fields.widgetsPublished !== undefined) {
    sets.push("widgets_published = ?");
    values.push(fields.widgetsPublished ? 1 : 0);
  }
  if (fields.publishToken !== undefined) {
    sets.push("publish_token = ?");
    values.push(fields.publishToken);
  }
  if (fields.publishedAt !== undefined) {
    sets.push("published_at = ?");
    values.push(fields.publishedAt);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE maps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteMap(id: string, db: Database = metadataDb()): boolean {
  return db.prepare(`DELETE FROM maps WHERE id = ?`).run(id).changes > 0;
}

// ---- layers ----

export function listLayers(mapId: string, db: Database = metadataDb()): Layer[] {
  return (
    db
      .prepare(`SELECT * FROM layers WHERE map_id = ? ORDER BY ordinal`)
      .all(mapId) as LayerRow[]
  ).map(layerFromRow);
}

export function getLayer(id: string, db: Database = metadataDb()): Layer | null {
  const row = db.prepare(`SELECT * FROM layers WHERE id = ?`).get(id) as
    | LayerRow
    | undefined;
  return row ? layerFromRow(row) : null;
}

export function insertLayer(layer: Layer, db: Database = metadataDb()): void {
  db.prepare(
    `INSERT INTO layers
       (id, map_id, name, sql, style, visible, tooltip, popup, published_fields, in_legend,
        viz, filters, legend_title, legend_labels, legend_attrs, ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    layer.id,
    layer.mapId,
    layer.name,
    layer.sql,
    JSON.stringify(layer.style),
    layer.visible ? 1 : 0,
    layer.tooltip ? JSON.stringify(layer.tooltip) : null,
    layer.popup ? JSON.stringify(layer.popup) : null,
    // Earlier history images restore without the field — null reads as
    // the derived default, which is the announced migration.
    layer.publishedFields ? JSON.stringify(layer.publishedFields) : null,
    layer.inLegend ? 1 : 0,
    layer.viz.type === "points" ? null : JSON.stringify(layer.viz),
    layer.filters.length ? JSON.stringify(layer.filters) : null,
    layer.legendTitle,
    layer.legendLabels ? JSON.stringify(layer.legendLabels) : null,
    layer.legendAttrs ? JSON.stringify(layer.legendAttrs) : null,
    layer.ordinal,
    layer.createdAt,
    layer.updatedAt,
  );
}

export function nextOrdinal(mapId: string, db: Database = metadataDb()): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(ordinal), -1) AS m FROM layers WHERE map_id = ?`)
    .get(mapId) as { m: number };
  return row.m + 1;
}

export function updateLayerFields(
  id: string,
  fields: Partial<{
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
    ordinal: number;
  }>,
  db: Database = metadataDb(),
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    values.push(fields.name);
  }
  if (fields.sql !== undefined) {
    sets.push("sql = ?");
    values.push(fields.sql);
  }
  if (fields.style !== undefined) {
    sets.push("style = ?");
    values.push(JSON.stringify(fields.style));
  }
  if (fields.visible !== undefined) {
    sets.push("visible = ?");
    values.push(fields.visible ? 1 : 0);
  }
  if (fields.tooltip !== undefined) {
    sets.push("tooltip = ?");
    values.push(fields.tooltip ? JSON.stringify(fields.tooltip) : null);
  }
  if (fields.popup !== undefined) {
    sets.push("popup = ?");
    values.push(fields.popup ? JSON.stringify(fields.popup) : null);
  }
  if (fields.publishedFields !== undefined) {
    sets.push("published_fields = ?");
    values.push(
      fields.publishedFields ? JSON.stringify(fields.publishedFields) : null,
    );
  }
  if (fields.inLegend !== undefined) {
    sets.push("in_legend = ?");
    values.push(fields.inLegend ? 1 : 0);
  }
  if (fields.viz !== undefined) {
    sets.push("viz = ?");
    values.push(fields.viz.type === "points" ? null : JSON.stringify(fields.viz));
  }
  if (fields.filters !== undefined) {
    sets.push("filters = ?");
    values.push(fields.filters.length ? JSON.stringify(fields.filters) : null);
  }
  if (fields.legendTitle !== undefined) {
    sets.push("legend_title = ?");
    values.push(fields.legendTitle);
  }
  if (fields.legendLabels !== undefined) {
    sets.push("legend_labels = ?");
    values.push(fields.legendLabels ? JSON.stringify(fields.legendLabels) : null);
  }
  if (fields.legendAttrs !== undefined) {
    sets.push("legend_attrs = ?");
    values.push(fields.legendAttrs ? JSON.stringify(fields.legendAttrs) : null);
  }
  if (fields.ordinal !== undefined) {
    sets.push("ordinal = ?");
    values.push(fields.ordinal);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE layers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteLayer(id: string, db: Database = metadataDb()): boolean {
  return db.prepare(`DELETE FROM layers WHERE id = ?`).run(id).changes > 0;
}

/** Apply a full ordering by id (spec: layer order is writable). */
export function reorderLayers(
  mapId: string,
  orderedIds: string[],
  db: Database = metadataDb(),
): void {
  const stmt = db.prepare(
    `UPDATE layers SET ordinal = ? WHERE id = ? AND map_id = ?`,
  );
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id, mapId));
  })();
}
