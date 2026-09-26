import type { LayerRenderData } from "@/lib/layer-service";
import type { FillPaint, LayerStyle, RgbaColor } from "@/lib/style/style";
import { effectiveStyle, isAggregated, type LayerViz } from "@/lib/viz";

/**
 * What a layer is, in one line: how much it draws, and whether that is
 * features or aggregate cells. The layer list has said this; the export
 * menu needs the same sentence, and two surfaces stating the same fact
 * differently is how they drift — so it is one function now.
 *
 * `null` means the render has not answered yet, which the caller shows
 * as it likes; a failed or building render says so in its own words.
 */
export function layerCount(
  viz: LayerViz | null | undefined,
  render: LayerRenderData | undefined,
): string | null {
  if (!render) return null;
  if (!render.ok) return "error";
  if (render.tiles?.state === "building") return "preparing tiles…";
  const count = render.featureCount;
  if (count === undefined || count === null) return null;
  const unit = viz && isAggregated(viz) ? "cells" : "features";
  return `${count.toLocaleString()} ${unit}`;
}

/** What kind of thing the layer draws, for surfaces that name it beside
 * the count — the export menu's row identity.
 *
 * A raw line or polygon layer uses the ordinary "points" viz mode, so
 * the viz alone answers "Points" for all three. The
 * render record knows the geometry, and it is the truthful source where
 * the viz has nothing to add. */
export function layerKind(
  viz: LayerViz | null | undefined,
  render?: LayerRenderData | undefined,
): string {
  if (!viz || viz.type === "points") {
    const geometry = (render?.ok ? render.geometryType : null)?.toUpperCase();
    if (geometry?.includes("POLYGON")) return "Polygons";
    if (geometry?.includes("LINE")) return "Lines";
    return "Points";
  }
  switch (viz?.type) {
    case "hexbin":
      return "Hex bins";
    case "grid":
      return "Grid";
    case "heatmap":
      return "Heatmap";
    case "cluster":
      return "Clusters";
    case "arc":
      return "Arcs";
    case "line":
      return "Lines";
    case "icon":
      return "Icons";
    default:
      return "Points";
  }
}

const css = (c: RgbaColor) => `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;

/** One paint channel's colors, in class order — all of them. An empty
 * data-driven list falls back to the constant stroke, the spine's own
 * fallback, never an invented color. */
function paintColors(paint: FillPaint, fallback: RgbaColor): string[] {
  if (paint.type === "constant") return [css(paint.color)];
  const colors =
    paint.type === "categorical"
      ? paint.map.map((m) => m.color)
      : paint.type === "quantile"
        ? paint.colors
        : paint.stops;
  return colors.length ? colors.map(css) : [css(fallback)];
}

/** The colors that identify the layer at a glance — the layer list's
 * spine and the export menu's swatch, one function (a field
 * find: the menu computed its own from the *stored* style, so a hexbin —
 * whose drawn ramp is the viz fill, projected by `effectiveStyle` —
 * showed whatever the point mode last held; it also capped at four
 * colors and blended them, so a long ramp read as its bottom end).
 *
 * The channel is the drawn one: lines and arcs take their visible color
 * from the stroke (a fill-only swatch showed a stale color once the
 * stroke was styled independently), everything else from the effective
 * fill. Every class color is returned, in order; callers render them as
 * stacked segments, exactly the spine. */
export function layerSwatch(
  style: LayerStyle,
  viz: LayerViz | null | undefined,
  render?: LayerRenderData,
): {
  colors: string[];
  ramp: boolean;
} {
  const effective = viz ? effectiveStyle(style, viz) : style;
  const kind = layerKind(viz, render);
  const colors =
    kind === "Lines" || kind === "Arcs"
      ? paintColors(
          effective.strokeBy ?? { type: "constant", color: effective.stroke },
          effective.stroke,
        )
      : paintColors(effective.fill, effective.stroke);
  return { colors, ramp: colors.length > 1 };
}
