import type { LayerRenderData, LayerRenderGeometryType } from "@/lib/layer-service";
import { getMap, type Layer } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";
import { publishedFieldsFor, publishedFieldsSignature, type PublishedMapContext } from "@/lib/publish/published-fields";
import { tilerUnavailable } from "@/lib/layer-render-copy";
import { ensureTiles } from "./build";
import { tilerAvailable } from "./tiler";
import { tileArchiveInfo } from "./serve";
import { requireTileAccess, type TileAccess } from "./access";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";

/**
 * The tiled render response for an over-cap simple-features layer: report
 * the build state for the layer's current effective query, kicking a build
 * off when tiles are missing or stale. A failed build is an errored layer;
 * a missing tiler degrades the same way h3 does.
 */
export async function tiledRender(
  layer: Layer,
  filters: LayerFilter[],
  geometryColumn: { name: string; type: string },
  nonGeometryColumns: string[],
  featureCount: number,
  geometryType: LayerRenderGeometryType,
  opts: { liveFiltered?: boolean; published?: boolean; tileAccess?: TileAccess; inputs?: ArtifactInputs } = {},
): Promise<LayerRenderData> {
  requireTileAccess(opts.tileAccess, layer.id);
  if (!(await tilerAvailable())) {
    return errored(
      layer.id,
      "tiler_unavailable",
      tilerUnavailable(featureCount),
    );
  }
  // One shared archive serves builder and published routes, built with the
  // effective published field set — resolved here against the map's own
  // context, whichever audience triggered the build. The signature folds
  // into the fingerprint; the published tile authorization recomputes it
  // from the same inputs.
  const mapRecord = getMap(layer.mapId);
  const context: PublishedMapContext = mapRecord
    ? {
        timeline: mapRecord.timeline,
        widgets: mapRecord.widgets,
        widgetsPublished: mapRecord.widgetsPublished,
      }
    : { timeline: null, widgets: [], widgetsPublished: false };
  const archiveColumns = publishedFieldsFor(layer, context, nonGeometryColumns);
  const status = ensureTiles(opts.tileAccess!, {
    layerId: layer.id,
    sql: layer.sql,
    // Live filters stay out of the fingerprint: window and slider moves
    // must never look like a data change and rebuild.
    filters,
    geometryColumn: geometryColumn.name,
    columns: archiveColumns,
    projection: publishedFieldsSignature(layer, context),
    // The identities the render's own evaluation bound decide freshness.
    inputs: opts.inputs,
  });
  if (status.state === "failed") {
    return errored(
      layer.id,
      "tile_build_failed",
      `Preparing tiles failed: ${status.error ?? "unknown error"}`,
    );
  }
  const base = {
    layerId: layer.id,
    ok: true,
    mode: "tiled" as const,
    featureCount,
    geometryType,
    ...(opts.liveFiltered ? { liveFiltered: true } : null),
    ...(opts.published ? { publishedFields: archiveColumns } : null),
  };
  if (status.state === "building") {
    return { ...base, tiles: { state: "building" } };
  }
  const info = await tileArchiveInfo(layer.id);
  requireTileAccess(opts.tileAccess, layer.id);
  // The version parameter lets tiles cache aggressively: a rebuild changes
  // builtAt, which changes every tile URL.
  const version = status.builtAt ? Date.parse(status.builtAt) : 0;
  return {
    ...base,
    tiles: {
      state: "ready",
      url: `/api/layers/${layer.id}/tiles/{z}/{x}/{y}?v=${version}`,
      builtAt: status.builtAt,
      ...(info ?? {}),
    },
  };
}

export function errored(
  layerId: string,
  code: string,
  message: string,
): LayerRenderData {
  return { layerId, ok: false, error: { code, message } };
}
