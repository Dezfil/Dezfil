import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { lit } from "@/lib/ingest/ingest";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { buildInlineAnswer, type FeatureBuilder } from "@/lib/query/render-features";
import { RenderBudget } from "@/lib/query/render-budget";
import { jsonBytes } from "@/lib/query/result-budget";
import type { SketchGeometry, SketchKind } from "./geometry";

/** One drawn feature as the features read answers it. */
export interface AnsweredSketchFeature {
  id: string;
  kind: SketchKind;
  geometry: SketchGeometry;
}

/** `{"id":…,"kind":…,"geometry":…}` without its three values. */
const FRAME = jsonBytes({ id: null, kind: null, geometry: null }) - 12;

const feature: FeatureBuilder<AnsweredSketchFeature> = (row) => {
  row.budget.take(FRAME);
  const id = row.value(0);
  const kind = row.value(1);
  // A missing kind is answered as the text "null", two bytes more than null.
  if (kind === null) row.budget.take(2);
  return { id: String(id), kind: String(kind) as SketchKind, geometry: row.geometry() as SketchGeometry };
};

function sketchBytesRefusal(limit: number): ApiError {
  return new ApiError(
    "render_bytes_exceeded",
    `This sketch's features are larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map. Raise DEZFIL_RENDER_CAP_BYTES and restart to edit it.`,
    422,
  );
}

/**
 * A sketch's features as its features read answers them, `{"features":
 * […]}`, built while they are read under Bytes drawn per layer: the
 * complete answer, envelope included, is counted before each value is
 * converted, equality is admitted, and an answer over the limit is refused
 * whole with 422 render_bytes_exceeded before it is built. `rows` is the
 * artifact's row count, read first: an emptied sketch's geometry column
 * has no geometry type to read.
 */
export async function sketchFeatureAnswer(
  conn: DuckDBConnection,
  abs: string,
  rows: number,
  limit: number,
): Promise<AnsweredSketchFeature[]> {
  const compose = (features: AnsweredSketchFeature[]) => ({ features });
  try {
    if (rows === 0) {
      new RenderBudget(limit).take(jsonBytes(compose([])));
      return [];
    }
    const operation = currentTrustedOperation();
    const answer = await buildInlineAnswer(
      conn,
      {
        from: `(SELECT feature_id, kind, geom FROM read_parquet(${lit(abs)}) WHERE feature_id IS NOT NULL) AS q`,
        geometry: "geom",
        properties: ["feature_id", "kind"],
        anchors: false,
      },
      compose,
      limit,
      () => { operation?.assertCanCommit(); return false; },
      { feature },
    );
    return answer.features;
  } catch (error) {
    if (error instanceof ApiError && error.code === "render_bytes_exceeded") throw sketchBytesRefusal(limit);
    throw error;
  }
}
