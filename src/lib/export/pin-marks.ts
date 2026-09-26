import type { LayerStyle } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";
import { REFERENCE_SPACE_WIDTH } from "./space";

/**
 * Pin the author's data marks to their share of the image (the third
 * directive).
 *
 * The composition's space scales everything drawn in it — that is how
 * the map-size step makes the basemap finer. But the author's own marks
 * were never supposed to ride along: an icon or a point radius should
 * keep its share of the exported image whatever the step. So every
 * pixel-sized data channel is scaled by `spaceWidth / REFERENCE`, and
 * its output share of the WIDTH is invariant across steps and output
 * widths. The overlays anchor to the short side instead; marks
 * deliberately keep the width share — they are map imagery, and moving
 * them is a trade nothing has ruled on (out of scope).
 *
 * The channels are enumerated from what the canvas actually consumes:
 *
 * - point radius and stroke width, constant and data-driven (their
 *   `range` is output pixels);
 * - data label text size — on pixel-labeled layers only: aggregated
 *   cells label in ground meters, which the space change already leaves
 *   alone, and scaling their source size would grow them ×2.67 at the
 *   default step;
 * - the heatmap's kernel radius.
 *
 * The cluster radius is deliberately NOT scaled here: the index is
 *   queried at integer zooms, so a continuously scaled radius against a
 *   floored query CHANGES the grouping at fractional compensations
 *   (a 33% coarser threshold on the default step).
 *   Aggregation parity lives in the canvas instead: it queries the
 *   cluster index at the space-compensated logical zoom, which lands on
 *   exactly the reference grouping, and draws the bubbles through
 *   `markScale`.
 *
 * Ground-anchored geometry is untouched by construction: hex and grid
 * cells are sized in kilometers, arcs span their endpoints, extrusion
 * is meters — the space change already leaves them alone, because
 * holding the ground is what the camera compensation is for.
 *
 * This module covers the channels a layer RECORD carries. The canvas
 * also mints pixel values of its own — mark floors, halo rims, the
 * cluster bubble's formula, its count text — and those ride the
 * composition's `markScale`, the same factor, threaded to the canvas
 * (the review's finding: a record-level transform alone would have
 * left the cluster chrome and every minimum behind). Applied in the
 * shared composition, so both roads get it by construction and neither
 * can drift.
 */

const scaleSize = (
  scale: LayerStyle["pointRadiusBy"],
  f: number,
): LayerStyle["pointRadiusBy"] =>
  scale && { ...scale, range: [scale.range[0] * f, scale.range[1] * f] };

export function pinMarksForSpace<
  T extends { style: LayerStyle; viz?: LayerViz },
>(layers: readonly T[], spaceWidth: number): T[] {
  const f = spaceWidth / REFERENCE_SPACE_WIDTH;
  if (Math.abs(f - 1) < 1e-9) return [...layers];
  return layers.map((layer) => {
    const aggregated =
      layer.viz?.type === "hexbin" || layer.viz?.type === "grid";
    const style: LayerStyle = {
      ...layer.style,
      pointRadius: layer.style.pointRadius * f,
      strokeWidth: layer.style.strokeWidth * f,
      pointRadiusBy: scaleSize(layer.style.pointRadiusBy, f),
      strokeWidthBy: scaleSize(layer.style.strokeWidthBy, f),
      label: layer.style.label
        ? {
            ...layer.style.label,
            // Aggregated SIZE alone stays ground-anchored; the pixel
            // offset is a screen-space channel on every branch. Halo
            // width is glyph-relative and NEVER rides f.
            ...(aggregated
              ? null
              : { size: layer.style.label.size * f }),
            ...(layer.style.label.offsetX != null && {
              offsetX: layer.style.label.offsetX * f,
            }),
            ...(layer.style.label.offsetY != null && {
              offsetY: layer.style.label.offsetY * f,
            }),
          }
        : layer.style.label,
    };
    const viz: LayerViz | undefined =
      layer.viz?.type === "heatmap"
        ? { ...layer.viz, radiusPx: layer.viz.radiusPx * f }
        : layer.viz;
    return { ...layer, style, viz };
  });
}
