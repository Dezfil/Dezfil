import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { buildInlineAnswer, type FeatureBuilder } from "@/lib/query/render-features";
import { jsonBytes } from "@/lib/query/result-budget";

/** One feature of a dataset as the dialog map draws it. */
export interface DatasetMapFeature {
  type: "Feature";
  /** The feature's position in the answer, stable across reads. */
  id: number;
  geometry: unknown;
  properties: { __table: string; __fid: number };
}

/** The answer when the dataset draws. */
export interface DatasetMapAnswer {
  ok: true;
  name: string;
  geometryType: string | null;
  featureCount: number;
  sampled?: boolean;
  totalCount?: number;
  geojson: { type: "FeatureCollection"; features: DatasetMapFeature[] };
}

/** The answer when it does not: no data, a sentence. */
export interface DatasetMapRefusal {
  ok: false;
  name: string;
  geometryType: string | null;
  reason: string;
}

function feature(name: string): FeatureBuilder<DatasetMapFeature> {
  return (row) => {
    const id = row.index;
    const properties = { __table: name, __fid: id };
    // Everything but the geometry, which is charged as it is read.
    row.budget.take(jsonBytes({ type: "Feature", id, geometry: null, properties }) - 4);
    return { type: "Feature", id, geometry: row.geometry(), properties };
  };
}

/** Why the features do not draw over Bytes drawn per layer: the whole
 * dataset, or the sample asked for. */
function overByteLimit(limit: number, sample: number | null): string {
  const what = sample === null ? "This table's features are" : `This table's first ${sample.toLocaleString("en-US")} features are`;
  return `${what} larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map, too large to draw here.`;
}

/**
 * A dataset's features for the dialog map, built while they are read under
 * Bytes drawn per layer, like a layer's answer: its complete JSON, envelope
 * included, is counted before each value is converted, and an answer over
 * the limit is never built whole. Over it, the answer is the refusal shape
 * with a sentence and no feature data. `sample` names the feature count of a
 * requested sample (the first features of a dataset over the render cap).
 */
export async function datasetMapAnswer(
  conn: DuckDBConnection,
  from: string,
  geometry: string,
  dataset: { name: string; geometryType: string | null; rowCount: number },
  sample: number | null,
  limit: number,
): Promise<DatasetMapAnswer | DatasetMapRefusal> {
  const { name, geometryType } = dataset;
  const operation = currentTrustedOperation();
  try {
    return await buildInlineAnswer(
      conn,
      {
        from: `(SELECT ${geometry} FROM ${from} WHERE ${geometry} IS NOT NULL${sample === null ? "" : ` LIMIT ${sample}`}) AS q`,
        geometry,
        properties: [],
        anchors: false,
      },
      (features: DatasetMapFeature[], count): DatasetMapAnswer => ({
        ok: true,
        name,
        geometryType,
        featureCount: count,
        ...(sample === null ? {} : { sampled: true, totalCount: dataset.rowCount }),
        geojson: { type: "FeatureCollection", features },
      }),
      limit,
      () => { operation?.assertCanCommit(); return false; },
      { feature: feature(name) },
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "render_bytes_exceeded")) throw error;
    return { ok: false, name, geometryType, reason: overByteLimit(limit, sample) };
  }
}
