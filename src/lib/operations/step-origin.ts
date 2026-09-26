import { filteredSql } from "@/lib/query/compile";
import { isAggregated, isOdViz, type LayerViz } from "@/lib/viz";
import type { LayerFilter } from "@/lib/viz";

/**
 * What a step authored from a layer consumes.
 *
 * Two rules, and both are the difference between an operation that means what
 * the user asked and one that quietly means something else.
 *
 * **The layer's SQL refined by its filters, and never its visualization
 * aggregation.** The layer compiler applies filters first and only then wraps
 * the result in hex bin, grid or origin–destination aggregation; a step takes
 * the composition from *before* that wrap. Buffering hexagons is not what
 * "buffer these stations" means — the user is looking at cells and would get an
 * answer about the cells rather than about their data.
 *
 * **The result is a snapshot.** Nothing re-reads the layer afterwards. A step
 * whose meaning drifted when someone edited a filter would not be reproducible,
 * and the accepted cost — that changing a filter and re-running gives the old
 * scope until the step is re-authored — is a cost only because the alternative
 * is worse.
 *
 * Where the substitution happens the step records that it did, so the API can
 * say so in as many words rather than leaving a user to discover that the thing
 * they were looking at is not the thing that ran.
 */

/** How a layer draws its result, in the words a substitution note uses. */
export type RenderedAs = "hexbin" | "grid" | "origin-destination" | "direct";

export interface LayerOrigin {
  layerId: string;
  mapId: string;
  layerName: string;
  /** What the layer was rendering when the step was authored from it. */
  renderedAs: RenderedAs;
  /** True when the layer aggregated and the step took its source instead. */
  substitutedSource: boolean;
  /** Present only when substituted: what the API tells the user, plainly. */
  substitutionNote?: string;
  /** How many filters were folded in, so a reader can tell a scope was applied. */
  filterCount: number;
  capturedAt: string;
}

export interface CapturedStepSource {
  /** The SQL the step will run — filtered, never aggregated. */
  sql: string;
  origin: LayerOrigin;
}

function renderedAs(viz: LayerViz): RenderedAs {
  if (isOdViz(viz)) return "origin-destination";
  if (isAggregated(viz)) return viz.type === "hexbin" ? "hexbin" : "grid";
  return "direct";
}

const NOTE: Record<Exclude<RenderedAs, "direct">, string> = {
  hexbin:
    "This layer is drawn as hexagonal bins. The operation runs on the rows " +
    "behind those bins, not on the bins themselves.",
  grid:
    "This layer is drawn as grid cells. The operation runs on the rows behind " +
    "those cells, not on the cells themselves.",
  "origin-destination":
    "This layer is drawn as origin–destination lines. The operation runs on " +
    "the rows behind those lines, not on the lines themselves.",
};

/**
 * Capture a layer as a step's input.
 *
 * Takes the layer's own fields rather than a layer id, so the capture is a
 * pure function of what was on screen — testable without a database, and
 * incapable of quietly re-reading the layer later, which is the property the
 * snapshot rule depends on.
 */
export function captureFromLayer(layer: {
  id: string;
  mapId: string;
  name: string;
  sql: string;
  filters: LayerFilter[];
  viz: LayerViz;
}): CapturedStepSource {
  const drawn = renderedAs(layer.viz);
  const substituted = drawn !== "direct";
  return {
    // Filters yes, aggregation no — the whole of E1 in one call.
    sql: filteredSql(layer.sql, layer.filters),
    origin: {
      layerId: layer.id,
      mapId: layer.mapId,
      layerName: layer.name,
      renderedAs: drawn,
      substitutedSource: substituted,
      ...(substituted ? { substitutionNote: NOTE[drawn] } : {}),
      filterCount: layer.filters.length,
      capturedAt: new Date().toISOString(),
    },
  };
}
