/**
 * The dataset format of a project export: one choice for every dataset
 * in the archive, shared by the review step, the request's validation
 * and the assembly — so the file list a user reads, the field the API
 * accepts and the members the archive holds can never disagree.
 * Dependency-free: the dialog imports it too.
 *
 * GeoParquet keeps each stored artifact byte for byte (the default,
 * and what an omitted request means). GeoJSON writes spatial datasets
 * as GeoJSON — a dataset without geometry cannot be GeoJSON and goes
 * as CSV instead, its real extension shown. CSV carries geometry as
 * WKT text, as the app's other CSV exports do.
 */

export const DATASET_FORMATS = ["geoparquet", "geojson", "csv"] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

export const DEFAULT_DATASET_FORMAT: DatasetFormat = "geoparquet";

export const DATASET_FORMAT_LABEL: Record<DatasetFormat, string> = {
  geoparquet: "GeoParquet",
  geojson: "GeoJSON",
  csv: "CSV",
};

/** The one-line help under the choice: what the pick costs or keeps. */
export const DATASET_FORMAT_HELP: Record<DatasetFormat, string> = {
  geoparquet: "Lossless. Reimports exactly.",
  geojson: "Opens in most tools. A dataset without geometry goes as CSV.",
  csv: "Tables; geometry as WKT text.",
};

const EXTENSION: Record<DatasetFormat, string> = {
  geoparquet: "parquet",
  geojson: "geojson",
  csv: "csv",
};

export function isDatasetFormat(value: unknown): value is DatasetFormat {
  return (
    typeof value === "string" &&
    (DATASET_FORMATS as readonly string[]).includes(value)
  );
}

/** The format a dataset is actually written in under a request: the
 * requested one, except that GeoJSON cannot hold a dataset without
 * geometry, which goes as CSV. */
export function effectiveDatasetFormat(
  requested: DatasetFormat,
  spatial: boolean,
): DatasetFormat {
  return requested === "geojson" && !spatial ? "csv" : requested;
}

export function datasetFileName(
  name: string,
  requested: DatasetFormat,
  spatial: boolean,
): string {
  return `${name}.${EXTENSION[effectiveDatasetFormat(requested, spatial)]}`;
}

/** Only the stored-artifact format has a size before assembly: a
 * conversion's size is not known until it is written, so the review
 * claims no total for it. */
export function sizeKnowable(requested: DatasetFormat): boolean {
  return requested === "geoparquet";
}
