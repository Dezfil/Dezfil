import type {
  CoordinateRow,
  LayerRow,
  PlaceRow,
  PlacesAnswer,
  SearchResponse,
  ValueRow,
} from "@/lib/search/contract";

/**
 * The dropdown's row model, pure: grouped for display, flattened for
 * the keyboard, and mapped to camera-and-marker actions per result
 * class — the S5 semantics live here where a unit can hold them. Row
 * ids anchor `aria-activedescendant`.
 */

/** The documented close zoom a point flight lands at. */
export const CLOSE_ZOOM = 14;

export type SearchRowKind = "layer" | "value" | "coordinate" | "place";

export interface SearchRow {
  kind: SearchRowKind;
  /** Stable within one render — the active-descendant anchor. */
  id: string;
  label: string;
  context: string | null;
  action: SearchAction;
}

export type SearchAction =
  | { type: "fit-layer"; layerId: string }
  | {
      type: "fly";
      lng: number;
      lat: number;
      zoom: number;
      marker: SearchMarker;
    }
  | {
      type: "fit";
      bounds: [number, number, number, number];
      marker: SearchMarker;
    };

export interface SearchMarker {
  lng: number;
  lat: number;
  label: string;
}

export interface SearchGroup {
  key: SearchRowKind;
  label: string;
  rows: SearchRow[];
}

export interface SearchRows {
  groups: SearchGroup[];
  /** Navigation order — the concatenated groups. */
  flat: SearchRow[];
  /** The places group's provider attribution, when it has one. */
  attribution: string | null;
}

/** The layer row's context line is its viz type (the prototype shows
 * one per layer row); the wire's type keys read as words. */
const VIZ_LABELS: Record<string, string> = {
  points: "Points",
  icon: "Icons",
  cluster: "Clusters",
  heatmap: "Heatmap",
  hexbin: "Hex bins",
  grid: "Grid",
  arc: "Arcs",
  line: "Lines",
};

function layerRow(r: LayerRow, i: number): SearchRow {
  return {
    kind: "layer",
    id: `search-layer-${i}`,
    label: r.name,
    context: VIZ_LABELS[r.viz] ?? r.viz,
    action: { type: "fit-layer", layerId: r.layerId },
  };
}

function valueRow(r: ValueRow, i: number): SearchRow {
  const marker: SearchMarker = r.point
    ? { lng: r.point[0], lat: r.point[1], label: r.value }
    : { lng: r.anchor![0], lat: r.anchor![1], label: r.value };
  return {
    kind: "value",
    id: `search-value-${i}`,
    label: r.value,
    context: r.layerName,
    action: r.point
      ? {
          type: "fly",
          lng: r.point[0],
          lat: r.point[1],
          zoom: CLOSE_ZOOM,
          marker,
        }
      : { type: "fit", bounds: r.bounds!, marker },
  };
}

/** "52.5, 13.4 — as latitude, longitude": the row is labelled with its
 * reading (S7), and the label is what the marker chip carries. */
function coordinateRow(r: CoordinateRow, i: number): SearchRow {
  const label =
    r.reading === "latlon" ? `${r.lat}, ${r.lng}` : `${r.lng}, ${r.lat}`;
  return {
    kind: "coordinate",
    id: `search-coordinate-${i}`,
    label,
    context:
      r.reading === "latlon"
        ? "as latitude, longitude"
        : "as longitude, latitude",
    action: {
      type: "fly",
      lng: r.lng,
      lat: r.lat,
      zoom: CLOSE_ZOOM,
      marker: { lng: r.lng, lat: r.lat, label },
    },
  };
}

/** A place flies to its point — or fits its bounding box when the
 * provider gave one — with the marker at the point either way (S5). */
function placeRow(r: PlaceRow, i: number): SearchRow {
  const marker: SearchMarker = { lng: r.lng, lat: r.lat, label: r.name };
  return {
    kind: "place",
    id: `search-place-${i}`,
    label: r.name,
    context: r.context,
    action: r.bounds
      ? { type: "fit", bounds: r.bounds, marker }
      : { type: "fly", lng: r.lng, lat: r.lat, zoom: CLOSE_ZOOM, marker },
  };
}

export function buildRows(input: {
  layers: LayerRow[];
  coordinates: CoordinateRow[];
  values: ValueRow[];
  places: PlacesAnswer | null;
}): SearchRows {
  const groups: SearchGroup[] = [];
  if (input.layers.length) {
    groups.push({
      key: "layer",
      label: "Layers on this map",
      rows: input.layers.map(layerRow),
    });
  }
  if (input.values.length) {
    groups.push({
      key: "value",
      label: "Values",
      rows: input.values.map(valueRow),
    });
  }
  if (input.coordinates.length) {
    groups.push({
      key: "coordinate",
      label: "Coordinates",
      rows: input.coordinates.map(coordinateRow),
    });
  }
  let attribution: string | null = null;
  if (input.places?.state === "ok" && input.places.results.length) {
    groups.push({
      key: "place",
      label: "Places",
      rows: input.places.results.map(placeRow),
    });
    attribution = input.places.attribution;
  }
  return { groups, flat: groups.flatMap((g) => g.rows), attribution };
}

/** The local groups the builder answers instantly, before (and beside)
 * the endpoint's reply — same shared modules, same semantics. */
export function instantGroups(
  server: SearchResponse | null,
  local: { layers: LayerRow[]; coordinates: CoordinateRow[] },
): { layers: LayerRow[]; coordinates: CoordinateRow[]; values: ValueRow[] } {
  return {
    layers: local.layers,
    coordinates: local.coordinates,
    values: server?.values ?? [],
  };
}
