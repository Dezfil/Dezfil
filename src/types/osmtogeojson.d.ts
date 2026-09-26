declare module "osmtogeojson" {
  interface OsmToGeoJsonOptions {
    flatProperties?: boolean;
  }
  interface GeoJsonGeometry {
    type: string;
    coordinates?: unknown;
    geometries?: GeoJsonGeometry[];
  }
  interface GeoJsonFeature {
    type: "Feature";
    id?: string | number;
    properties: Record<string, unknown> | null;
    geometry: GeoJsonGeometry | null;
  }
  interface GeoJsonFeatureCollection {
    type: "FeatureCollection";
    features: GeoJsonFeature[];
  }
  function osmtogeojson(
    data: unknown,
    options?: OsmToGeoJsonOptions,
  ): GeoJsonFeatureCollection;
  export default osmtogeojson;
}
