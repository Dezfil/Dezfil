import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { buildInlineAnswer, type FeatureBuilder } from "@/lib/query/render-features";
import { jsonBytes } from "@/lib/query/result-budget";

/** One feature of a Run Query preview: its position and its geometry. */
interface PreviewFeature {
  type: "Feature";
  id: number;
  geometry: unknown;
  properties: Record<string, never>;
}

/** A Run Query result: the features the matching import would land,
 * capped by the render cap with truncation stated. */
export interface FeaturePreview {
  geojson: { type: "FeatureCollection"; features: unknown[] };
  featureCount: number;
  truncated: boolean;
  cap: number;
}

const feature: FeatureBuilder<PreviewFeature> = (row) => {
  const id = row.index;
  // Everything but the geometry, which is charged as it is read.
  row.budget.take(jsonBytes({ type: "Feature", id, geometry: null, properties: {} }) - 4);
  return { type: "Feature", id, geometry: row.geometry(), properties: {} };
};

/** Why a selection does not preview over Bytes drawn per layer. The import
 * itself is not held to that limit, which is the surprise worth naming. */
function overtureBytesRefusal(limit: number): string {
  return `This selection's features are larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map, too large to preview here. Importing them is not affected.`;
}

/**
 * A selection's preview, built while it is read under Bytes drawn per
 * layer, like a layer's answer: its complete JSON, envelope included, is
 * counted before each value is converted, and a preview over the limit is
 * refused whole with 422 render_bytes_exceeded before it is built.
 * `selected` yields the selection's `geometry` column, at most one row
 * over the cap, so that `truncated` states whether more features matched.
 */
export async function overturePreviewAnswer(
  conn: DuckDBConnection,
  selected: string,
  cap: number,
  limit: number,
): Promise<FeaturePreview> {
  const operation = currentTrustedOperation();
  try {
    return await buildInlineAnswer(
      conn,
      { from: `(${selected}) AS q`, geometry: "geometry", properties: [], anchors: false },
      (features: PreviewFeature[], count, more): FeaturePreview => ({
        geojson: { type: "FeatureCollection", features },
        featureCount: count,
        truncated: more,
        cap,
      }),
      limit,
      () => { operation?.assertCanCommit(); return false; },
      { feature, take: cap },
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "render_bytes_exceeded") {
      throw new ApiError("render_bytes_exceeded", overtureBytesRefusal(limit), 422);
    }
    throw error;
  }
}
