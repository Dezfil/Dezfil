import { ApiError } from "@/lib/api/errors";
import { layerFieldsFromBody } from "@/lib/layer-document-rules";
import {
  normalizeBasemapLayers,
  normalizeLegendOrder,
  normalizeTimeline,
  normalizeViewport,
  normalizeWidgets,
  requireBasemapKey,
  requireLegendCorner,
  requireWidgetsPublished,
} from "@/lib/map-document-rules";
import { styleProblem, type LayerStyle } from "@/lib/style/style";
import type { LayerFilter, LayerViz, LegendAttrs } from "@/lib/viz";
import type { MapWidget } from "@/lib/widgets";
import { refuse } from "./refusals";

/**
 * A template's map document under the map write's rules: the first stage
 * of the admission for the map, and what a template's map reads as when it
 * is answered from its folder. Light on purpose (the write roads' rules
 * and nothing else), so the readers the map's own roads depend on may use
 * it.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An id the copy rebinds and a file may be named by: no separator, no
 * dot, nothing a path could be built from. */
export const TEMPLATE_PART_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function invalidDocument(message: string): never {
  return refuse("template_invalid", message);
}

/** A write road's refusal, worded for the document it came from. */
export function underRule<T>(where: string, rule: () => T): T {
  try {
    return rule();
  } catch (error) {
    if (error instanceof ApiError) invalidDocument(`${where}: ${error.message}`);
    throw error;
  }
}

/** A layer as admitted: its own id and the fields a copy writes. */
export interface AdmittedLayer {
  id: string;
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
}

export interface AdmittedMap {
  id: string;
  name: string;
  file: string;
  viewport: ReturnType<typeof normalizeViewport>;
  basemap: ReturnType<typeof requireBasemapKey>;
  basemapLayers: ReturnType<typeof normalizeBasemapLayers>;
  legendCorner: ReturnType<typeof requireLegendCorner>;
  legendOrder: string[] | null;
  timeline: ReturnType<typeof normalizeTimeline> | null;
  widgets: MapWidget[];
  widgetsPublished: boolean;
  layers: AdmittedLayer[];
}

function layerOf(value: unknown, at: string): AdmittedLayer {
  if (!isObject(value)) invalidDocument(`${at} must be an object.`);
  const layer = value as Record<string, unknown>;
  if (typeof layer.id !== "string" || !TEMPLATE_PART_ID.test(layer.id)) invalidDocument(`${at} needs an id of letters, digits, hyphens and underscores.`);
  const fields = underRule(at, () => layerFieldsFromBody({ ...layer }));
  for (const key of ["name", "sql", "style", "visible", "inLegend", "viz", "filters"] as const) {
    if (fields[key] === undefined) invalidDocument(`${at} has no ${key}.`);
  }
  const problem = styleProblem(fields.style);
  if (problem) invalidDocument(`${at}: The style is not valid: ${problem}`);
  return {
    id: layer.id as string,
    name: fields.name!,
    sql: fields.sql!,
    style: fields.style!,
    visible: fields.visible!,
    tooltip: fields.tooltip ?? null,
    popup: fields.popup ?? null,
    publishedFields: fields.publishedFields ?? null,
    inLegend: fields.inLegend!,
    viz: fields.viz!,
    filters: fields.filters!,
    legendTitle: fields.legendTitle ?? null,
    legendLabels: fields.legendLabels ?? null,
    legendAttrs: fields.legendAttrs ?? null,
  };
}

/**
 * Admit a map document under the map write's rules, against its own
 * layers: what a client could write as a map is what a template's map may
 * be. Refuses with the invalid refusal, naming the document.
 */
export function admitMapDocument(value: unknown, file: string): AdmittedMap {
  const at = `The map "${file}"`;
  if (!isObject(value)) invalidDocument(`${at} must be a JSON object.`);
  const map = value as Record<string, unknown>;
  if (typeof map.id !== "string" || !TEMPLATE_PART_ID.test(map.id)) invalidDocument(`${at} needs an id of letters, digits, hyphens and underscores.`);
  if (typeof map.name !== "string" || map.name.trim() === "") invalidDocument(`${at} needs a name.`);
  if (map.note !== undefined && map.note !== null) {
    invalidDocument(`${at}: The map note is now a note widget. Send it in \`widgets\`.`);
  }
  if (!Array.isArray(map.layers)) invalidDocument(`${at} must list its layers.`);
  const layers = (map.layers as unknown[]).map((l, i) => layerOf(l, `${at}, layer ${i + 1}`));
  const layerIds = layers.map((l) => l.id);
  if (new Set(layerIds).size !== layerIds.length) invalidDocument(`${at} names one layer id twice.`);
  return underRule(at, () => ({
    id: map.id as string,
    name: (map.name as string).trim(),
    file,
    viewport: normalizeViewport(map.viewport),
    basemap: requireBasemapKey(map.basemap ?? null),
    basemapLayers: map.basemapLayers == null ? null : normalizeBasemapLayers(map.basemapLayers),
    legendCorner: requireLegendCorner(map.legendCorner ?? null),
    legendOrder: map.legendOrder == null ? null : normalizeLegendOrder(map.legendOrder, layerIds),
    timeline: map.timeline == null ? null : normalizeTimeline(map.timeline, layers),
    // Nothing is stored for a document from outside, so there is no echo
    // to tolerate: every widget names a layer of this map.
    widgets: normalizeWidgets(map.widgets ?? [], layerIds, []),
    widgetsPublished: requireWidgetsPublished(map.widgetsPublished ?? true),
    layers,
  }));
}
