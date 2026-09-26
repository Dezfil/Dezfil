import type { LayerRenderData } from "@/lib/layer-service";
import { boundsOf, expandBounds, type Bounds } from "@/lib/geo-bounds";
import type { ExtentLayer } from "@/lib/map-extent";
import type { LiveDim } from "@/lib/live-filters";

export type GeometryKind = "point" | "line" | "polygon" | "mixed" | null;

/** Geometry-aware controls prefer the server's render-mode-independent
 * metadata. Inline feature inspection remains only for responses from an
 * older server that did not provide a recognized family. */
export function renderGeometryKind(
  render?: LayerRenderData,
): GeometryKind {
  if (!render?.ok) return null;
  if (render.geometryType === "POINT") return "point";
  if (render.geometryType === "LINESTRING") return "line";
  if (render.geometryType === "POLYGON") return "polygon";
  if (render.geometryType === "MIXED") return "mixed";
  if (render.geometryType === null) return null;

  const gj = render.geojson as {
    features?: { geometry?: { type?: string } | null }[];
  };
  if (!gj?.features) return null;
  const kinds = new Set<Exclude<GeometryKind, null>>();
  for (const feature of gj.features) {
    const type = feature.geometry?.type ?? "";
    if (type.includes("Point")) kinds.add("point");
    else if (type.includes("LineString")) kinds.add("line");
    else if (type.includes("Polygon")) kinds.add("polygon");
    if (kinds.size > 1) return "mixed";
  }
  return kinds.size === 1 ? [...kinds][0] : null;
}

export type VizType =
  | "points"
  | "hexbin"
  | "grid"
  | "heatmap"
  | "arc"
  | "line"
  | "icon"
  | "cluster";

export interface VizTileContext {
  /** The layer currently renders as vector tiles (over the render cap). */
  tiled?: boolean;
  /** The result can express two O→D endpoints. */
  odPossible?: boolean;
  /** The layer's BASE result is point data. A non-points visualization
   * implies it (aggregations and point vizzes require a point base), even
   * though the current render's geometry is cells or paths — the escape
   * path back to every point-family type stays open. */
  pointBase?: boolean;
}

/** One type tile's state: the grid shows on every layer, and a
 * type the layer's data cannot support is visibly unavailable with a short
 * reason instead of failable. The geometry tile ("points") always works —
 * it is also the escape path back to simple features when the data under a
 * non-point visualization changes shape. */
export function vizTile(
  kind: GeometryKind,
  type: VizType,
  context: VizTileContext = {},
): { available: boolean; reason?: string } {
  if (type === "points") return { available: true };
  if (type === "arc" || type === "line") {
    const what = type === "arc" ? "Arcs" : "Origin→destination lines";
    if (context.tiled) {
      return {
        available: false,
        reason: `${what} apply within the standard rendering path. This layer renders as tiles; filter or aggregate it down first.`,
      };
    }
    if (!context.odPossible) {
      return {
        available: false,
        reason: `${what} need origin and destination fields: two geometry columns, or longitude/latitude column pairs.`,
      };
    }
    return { available: true };
  }
  if ((type === "icon" || type === "cluster") && context.tiled) {
    const noun = type === "icon" ? "Icons" : "Clusters";
    return {
      available: false,
      reason: `${noun} apply within the standard rendering path. This layer renders as tiles; filter or aggregate it down first.`,
    };
  }
  if (kind === "point" || context.pointBase) return { available: true };
  const what =
    kind === "line"
      ? "paths"
      : kind === "polygon"
        ? "polygons"
        : kind === "mixed"
          ? "mixed geometry"
          : "no known point result";
  const noun =
    type === "heatmap"
      ? "A heatmap"
      : type === "hexbin"
        ? "Hex binning"
        : type === "icon"
          ? "The icon type"
          : type === "cluster"
            ? "Clustering"
            : "The grid";
  return {
    available: false,
    reason: `${noun} needs a point result. This layer draws ${what}.`,
  };
}

/** Fetch a single layer's render data. Never throws — a failed render is a
 * layer state, not a page error (spec: errored layers). */
export async function fetchLayerRender(
  layerId: string,
): Promise<LayerRenderData> {
  try {
    const response = await fetch(`/api/layers/${layerId}/render`);
    const body = (await response.json()) as LayerRenderData;
    return body;
  } catch {
    return {
      layerId,
      ok: false,
      error: { code: "network", message: "Could not reach the server." },
    };
  }
}

/** The answer to an extent request: a box, nothing drawn, or a failure —
 * three outcomes, because filtering everything away is normal and must not
 * read as broken. */
export type ExtentAnswer =
  | { ok: true; box: [number, number, number, number] | null }
  | { ok: false; message: string };

/** Ask the server for a layer's current extent — the case the browser
 * cannot answer, a tiled layer under a constraint the canvas enforces. */
export async function fetchLayerExtent(
  layerId: string,
  dims: LiveDim[],
): Promise<ExtentAnswer> {
  try {
    const response = await fetch(`/api/layers/${layerId}/extent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dims }),
    });
    if (!response.ok) {
      return {
        ok: false,
        message:
          "The map could not be fitted to the filtered data. Its extent could not be computed.",
      };
    }
    const body = (await response.json()) as {
      kind: "extent" | "empty";
      box?: [number, number, number, number];
    };
    return { ok: true, box: body.kind === "extent" ? (body.box ?? null) : null };
  } catch {
    return {
      ok: false,
      message:
        "The map could not be fitted to the filtered data. The server could not be reached.",
    };
  }
}

/** Data extent across renders: inline features plus tiled archives' boxes.
 * The unconstrained extent — what a layer holds before anything the canvas
 * enforces. Fitting asks for the *effective* extent instead (extentLayers
 * below); this stays for the callers that genuinely want the whole layer,
 * such as framing a freshly imported one. */
export function renderBounds(renders: LayerRenderData[]): Bounds | null {
  const collections = renders
    .filter((r) => r.ok && r.geojson)
    .map((r) => r.geojson as { features?: unknown[] });
  let b = boundsOf(collections);
  for (const r of renders) {
    if (r.ok && r.tiles?.bounds) b = expandBounds(b, r.tiles.bounds);
  }
  return b;
}

/**
 * The builder's layers in the shared extent contract: what is actually
 * drawn, and under which constraints.
 *
 * Two substitutions matter. A layer with a settle re-render draws THAT
 * geometry — a widget selection on a cell visualization produces new cells
 * and the canvas swaps them in — so the extent must measure it rather than
 * the canonical render underneath. And a settle render is inline even when
 * the canonical one was tiled, which is why its archive box drops away
 * with it.
 */
export function extentLayers(
  renders: Record<string, LayerRenderData>,
  options: {
    /** Layer id → whether the author has it shown. */
    visible: (layerId: string) => boolean;
    /** Layer id → the selection-specific render, when one is drawn. */
    staged?: Record<string, LayerRenderData | undefined>;
    /** Layer id → the constraints the canvas is enforcing. */
    dims: Record<string, LiveDim[]>;
    /** Restrict to these ids (the per-layer action); all of them if absent. */
    only?: string[];
  },
): ExtentLayer[] {
  const ids = options.only ?? Object.keys(renders);
  return ids.flatMap((id) => {
    const canonical = renders[id];
    if (!canonical?.ok) return [];
    const settle = options.staged?.[id];
    const drawn = settle?.ok && settle.geojson ? settle : canonical;
    return [
      {
        id,
        visible: options.visible(id),
        geojson: drawn.geojson ?? null,
        tiles: drawn.geojson ? null : (canonical.tiles?.bounds ?? null),
        dims: options.dims[id] ?? [],
      },
    ];
  });
}

export type { LayerRenderData };
