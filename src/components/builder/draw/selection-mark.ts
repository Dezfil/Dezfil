import type { SketchGeometry } from "@/lib/sketch/geometry";

/**
 * The selection mark: what a selected drawn shape shows on the map,
 * decided from its kind and its own stored geometry. Every kind gets the
 * outline the shipped selected-polygon treatment already draws; handles
 * stay with the two kinds whose vertices the store lets move — a handle
 * on a circle would appear and then do nothing. Pure, so the rule is
 * exercised on real coordinates without a map; the overlay only projects
 * what this returns.
 */

export type Ground = [number, number];

/** The kinds whose selected vertices can be dragged. */
export const VERTEX_EDITABLE_KINDS: readonly string[] = ["polygon", "freehand"];

export function hasVertexHandles(kind: string): boolean {
  return VERTEX_EDITABLE_KINDS.includes(kind);
}

/** A selected point's ring radius in screen pixels: a point has no
 * extent of its own, so its mark surrounds its position. Wider than the
 * sketch style's rendered point (4 px). */
export const POINT_MARK_PX = 12;

export type SelectionMark =
  | {
      shape: "outline";
      /** The feature's own positions, uncopied — a freehand ring may
       * run to the published vertex ceiling. */
      trace: Ground[];
      closed: boolean;
      /** One per vertex where vertex editing exists; empty otherwise. */
      handles: Ground[];
    }
  | { shape: "point"; position: Ground };

const POLYGON_KINDS: readonly string[] = [
  "polygon",
  "rectangle",
  "circle",
  "freehand",
];

/** The mark for a kind and its geometry; null when the two are not of
 * one family, so a mismatched row draws nothing rather than something
 * wrong. */
export function selectionMarkFor(
  kind: string,
  geometry: SketchGeometry,
): SelectionMark | null {
  if (kind === "point" && geometry.type === "Point")
    return { shape: "point", position: geometry.coordinates };
  if (kind === "line" && geometry.type === "LineString")
    return {
      shape: "outline",
      trace: geometry.coordinates,
      closed: false,
      handles: [],
    };
  if (POLYGON_KINDS.includes(kind) && geometry.type === "Polygon") {
    const ring = geometry.coordinates[0];
    return {
      shape: "outline",
      trace: ring,
      closed: true,
      // The closing duplicate carries no handle of its own.
      handles: hasVertexHandles(kind) ? ring.slice(0, -1) : [],
    };
  }
  return null;
}
