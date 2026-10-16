/**
 * The map-search result contract. One endpoint answers four result
 * classes in the grouped shape the builder consumes; the same types
 * describe what an agent tool receives, so the UI cannot hold a search
 * ability the API lacks (S-api). Browser-safe: no server imports.
 */

/** A layer whose name matches the query. `viz` is the layer's
 * visualization type — the row's context line, as the ratified
 * prototype shows one per layer row. */
export interface LayerRow {
  layerId: string;
  name: string;
  viz: string;
}

/** One matching feature of a visible layer (defaults: text fields,
 * case-insensitive substring, one row per feature, 20 across layers).
 * The geometry metadata rides along so selection needs no second round
 * trip: points fly to `point`; lines and polygons fit `bounds` with the
 * marker at `anchor` — the same representative-point semantics labels
 * use. */
export interface ValueRow {
  layerId: string;
  /** The context line: which layer the feature came from. */
  layerName: string;
  field: string;
  value: string;
  /** Present on point features. [lng, lat] */
  point?: [number, number];
  /** Present on non-point features. [lng, lat], interior. */
  anchor?: [number, number];
  /** Present on non-point features. [minLng, minLat, maxLng, maxLat] */
  bounds?: [number, number, number, number];
}

/** A visible layer whose matching values were refused: one of them is
 * longer than the per-value ceiling. It answers no value rows; the others
 * answer as usual. The pair is the one a failed widget carries. */
export interface RefusedLayer {
  layerId: string;
  layerName: string;
  error: string;
  /** A documented error code: query_result_too_large. */
  errorCode: string;
}

/** One reading of a pasted decimal pair (S7). When both readings are
 * plausible, both rows appear, each labelled by its reading. */
export interface CoordinateRow {
  reading: "latlon" | "lonlat";
  lat: number;
  lng: number;
}

/** A normalized place from the configured provider (S3b). */
export interface PlaceRow {
  name: string;
  /** The context line: the rest of the provider's display name. */
  context: string | null;
  lng: number;
  lat: number;
  /** [minLng, minLat, maxLng, maxLat] when the provider gives one. */
  bounds?: [number, number, number, number];
}

/**
 * The places group's answer, present only when places were asked for
 * (a submitted search). Failures resolve here rather than failing the
 * whole search — a submit must never cost the local answers. Messages
 * are sanitized: the configured URL never crosses this boundary.
 */
export type PlacesAnswer =
  | { state: "unconfigured" }
  | { state: "ok"; attribution: string | null; results: PlaceRow[] }
  | { state: "failed"; message: string };

/** The grouped search response. */
export interface SearchResponse {
  layers: LayerRow[];
  values: ValueRow[];
  /** Present only when a layer's values were refused. */
  refusedLayers?: RefusedLayer[];
  coordinates: CoordinateRow[];
  places?: PlacesAnswer;
}

/** The bound: at most this many value rows per search, across all
 * layers (20 shipped). */
export const VALUE_ROW_BOUND = 20;
