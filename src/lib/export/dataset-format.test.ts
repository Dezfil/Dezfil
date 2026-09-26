import { describe, it, expect } from "vitest";
import {
  DATASET_FORMATS,
  DEFAULT_DATASET_FORMAT,
  datasetFileName,
  effectiveDatasetFormat,
  isDatasetFormat,
  sizeKnowable,
} from "./dataset-format";

/** The shared format contract, prescribed as
 * literals so the dialog and the assembly are held to the same words. */
describe("the dataset format contract", () => {
  it("offers exactly three formats with GeoParquet the default", () => {
    expect([...DATASET_FORMATS]).toEqual(["geoparquet", "geojson", "csv"]);
    expect(DEFAULT_DATASET_FORMAT).toBe("geoparquet");
    expect(isDatasetFormat("geojson")).toBe(true);
    expect(isDatasetFormat("shapefile")).toBe(false);
    expect(isDatasetFormat(undefined)).toBe(false);
  });

  it("GeoJSON cannot hold a dataset without geometry: it goes as CSV, its real extension shown", () => {
    expect(effectiveDatasetFormat("geojson", true)).toBe("geojson");
    expect(effectiveDatasetFormat("geojson", false)).toBe("csv");
    expect(effectiveDatasetFormat("csv", true)).toBe("csv");
    expect(effectiveDatasetFormat("geoparquet", false)).toBe("geoparquet");
    expect(datasetFileName("stations", "geoparquet", true)).toBe("stations.parquet");
    expect(datasetFileName("stations", "geojson", true)).toBe("stations.geojson");
    expect(datasetFileName("readings", "geojson", false)).toBe("readings.csv");
    expect(datasetFileName("stations", "csv", true)).toBe("stations.csv");
  });

  it("only the stored format has a size before assembly", () => {
    expect(sizeKnowable("geoparquet")).toBe(true);
    expect(sizeKnowable("geojson")).toBe(false);
    expect(sizeKnowable("csv")).toBe(false);
  });
});
