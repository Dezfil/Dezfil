import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { DocumentFacts } from "@/lib/metadata/document-facts";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { MapPresence } from "@/lib/reach-presence";
import { isTemplateDocumentId, parseTemplateDocumentId, templateDocumentId } from "./ids";
import { residentTemplate, type ResidentTemplate } from "./resident";
import type { AdmittedMap } from "./map-document";

/**
 * A template's map and its layers as the map and layer reads answer them,
 * from the installed folder: for every signed-in account, read only.
 *
 * The map answers under the template's map id, each layer under its
 * template layer id, and everything that names a layer (the widgets, the
 * legend order, the timeline) names it by that id, so each road a map's
 * reader calls (a layer's render, the widget values, an extent, the
 * search) is asked with ids that come back here. It is filed nowhere, it
 * is never published, and it has no stored revision: its revision is its
 * version's archive checksum, no one has changed it, and its owner and
 * SQL home name the template, never an account.
 */

/** Who a template's map names as its owner and SQL home: no account. */
export const TEMPLATE_OWNER = { name: "Template", sqlName: "template" } as const;

export type TemplateMapRead = MapWithLayers & MapPresence & DocumentFacts;

function factsOf(resident: ResidentTemplate): DocumentFacts {
  return { editRevision: resident.record.archive.sha256.slice(0, 32), lastChangedAt: null, lastChangedBy: null };
}

/** A version's map as its reads name it: each layer under its template
 * layer id on the template's map, and the timeline and widgets naming
 * layers by those ids. The admission of a version not yet installed reads
 * its layers this way too, so it renders them as its view will. */
export function templateMapLayers(
  template: string,
  version: number,
  map: AdmittedMap,
  times: { createdAt: string; updatedAt: string },
): { mapId: string; layers: Layer[]; timeline: TemplateMapRead["timeline"]; widgets: TemplateMapRead["widgets"] } {
  const mapId = templateDocumentId({ template, version, kind: "map" });
  const layerId = (part: string) => templateDocumentId({ template, version, kind: "layer", part });
  return {
    mapId,
    layers: map.layers.map((layer, ordinal) => ({ ...layer, id: layerId(layer.id), mapId, ordinal, ...times })),
    timeline: map.timeline ? { ...map.timeline, layerId: layerId(map.timeline.layerId) } : null,
    widgets: map.widgets.map((widget) => (widget.layerId === null ? { ...widget } : { ...widget, layerId: layerId(widget.layerId) })),
  };
}

/** The map of an installed version, as every map read answers a map. */
export function templateMapAnswer(resident: ResidentTemplate): TemplateMapRead {
  const { id: template, version, map } = resident;
  const { mapId, layers: read, timeline, widgets } =
    templateMapLayers(template, version, map, { createdAt: resident.createdAt, updatedAt: resident.updatedAt });
  const layerId = (part: string) => templateDocumentId({ template, version, kind: "layer", part });
  const facts = factsOf(resident);
  const layers: (Layer & DocumentFacts)[] = read.map((layer) => ({ ...layer, ...facts }));
  return {
    id: mapId,
    name: map.name,
    viewport: map.viewport,
    basemap: map.basemap,
    customBasemap: null,
    basemapLayers: map.basemapLayers,
    note: null,
    legendCorner: map.legendCorner,
    legendOrder: map.legendOrder?.map(layerId) ?? null,
    timeline,
    widgets,
    widgetsPublished: map.widgetsPublished,
    publishToken: null,
    publishedAt: null,
    published: false,
    createdAt: resident.createdAt,
    updatedAt: resident.updatedAt,
    layers,
    projectId: null,
    owner: { ...TEMPLATE_OWNER },
    home: TEMPLATE_OWNER.sqlName,
    ...facts,
  };
}

function residentOf(scope: AccountScope, id: string, kind: "map" | "layer"): { resident: ResidentTemplate; part?: string } {
  requireAccountScope(scope);
  const ref = parseTemplateDocumentId(id);
  if (!ref || ref.kind !== kind) throw resourceAbsent();
  const resident = residentTemplate(ref.template, ref.version);
  if (!resident) throw resourceAbsent();
  return { resident, part: ref.part };
}

/** A template's map, for any signed-in account; a template id that no
 * installed version answers to, or that names no map, is the absent
 * refusal. */
export function readTemplateMap(scope: AccountScope, id: string): TemplateMapRead {
  return templateMapAnswer(residentOf(scope, id, "map").resident);
}

/** A layer of a template's map, likewise. */
export function readTemplateLayer(scope: AccountScope, id: string): Layer & DocumentFacts {
  const { resident } = residentOf(scope, id, "layer");
  const layer = templateMapAnswer(resident).layers.find((candidate) => candidate.id === id);
  if (!layer) throw resourceAbsent();
  return layer as Layer & DocumentFacts;
}

/** The map-level state a template layer's render reads, by the map's id:
 * the docked timeline and the widgets, under the template's layer ids;
 * null when no installed version answers. */
export function templateMapContext(mapId: string): Pick<TemplateMapRead, "timeline" | "widgets"> | null {
  const ref = parseTemplateDocumentId(mapId);
  const resident = ref?.kind === "map" ? residentTemplate(ref.template, ref.version) : null;
  if (!resident) return null;
  const { timeline, widgets } = templateMapAnswer(resident);
  return { timeline, widgets };
}

/** The docked timeline of a template's map, by the map's id, for the
 * render's split of live filters; null when no installed version answers. */
export function templateMapTimeline(mapId: string): TemplateMapRead["timeline"] {
  return templateMapContext(mapId)?.timeline ?? null;
}

/** The absent refusal for a template's id, on a road that answers nothing of
 * a template's: its map has no history, sketches, dependencies, tiles or
 * exports. */
export function refuseTemplateDocument(id: string): void {
  if (isTemplateDocumentId(id)) throw resourceAbsent();
}
