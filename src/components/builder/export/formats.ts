/** The three layer-export formats as every door labels them, mirroring
 * the table menu. Layers always carry geometry, so all three
 * are always offered. */
export const LAYER_EXPORT_FORMATS = [
  { format: "geoparquet", label: "GeoParquet", hint: "as stored" },
  { format: "geojson", label: "GeoJSON", hint: "interchange" },
  { format: "csv", label: "CSV", hint: "geometry as WKT" },
] as const;

export type LayerDataFormat = (typeof LAYER_EXPORT_FORMATS)[number]["format"];

export function isLayerDataFormat(value: unknown): value is LayerDataFormat {
  return LAYER_EXPORT_FORMATS.some((entry) => entry.format === value);
}

export function layerDataFormatLabel(format: LayerDataFormat): string {
  return LAYER_EXPORT_FORMATS.find((entry) => entry.format === format)!.label;
}
