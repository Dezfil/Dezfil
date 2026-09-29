import type { Database } from "better-sqlite3";
import { recoverCamera } from "@/lib/camera-bounds";
import { normalizeStyle } from "@/lib/style/style";
import { normalizeViz, POINTS_VIZ, type LayerFilter, type LayerViz, type LegendAttrs } from "@/lib/viz";
import type { BasemapKey } from "@/lib/basemap";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { Corner } from "@/lib/corners";
import type { MapTimeline } from "@/lib/timeline";
import { normalizeWidget, type MapWidget } from "@/lib/widgets";
import { metadataDb } from "./db";
import type { CustomBasemap, Layer, MapNote, MapRecord } from "./maps";

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
