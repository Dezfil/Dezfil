import { describe, expect, it } from "vitest";
import {
  SKETCH_MAX_VERTICES,
  sketchFeatureError,
  sketchGeometryWkt,
  sketchVertexCount,
  type SketchGeometry,
} from "./geometry";

const ring = (n: number): [number, number][] => {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([i / 1000, i / 2000]);
  pts.push(pts[0]);
  return pts;
};

const point = { kind: "point", geometry: { type: "Point", coordinates: [13.4, 52.5] } };
const line = {
  kind: "line",
  geometry: { type: "LineString", coordinates: [[13.4, 52.5], [13.5, 52.6]] },
};
const polygon = {
  kind: "polygon",
  geometry: { type: "Polygon", coordinates: [ring(3)] },
};

describe("sketchFeatureError", () => {
  it("passes each family in its kind", () => {
    expect(sketchFeatureError(point)).toBeNull();
    expect(sketchFeatureError(line)).toBeNull();
    expect(sketchFeatureError(polygon)).toBeNull();
    for (const kind of ["rectangle", "circle", "freehand"])
      expect(sketchFeatureError({ ...polygon, kind })).toBeNull();
  });

  it("refuses a kind/family mismatch with a sentence", () => {
    expect(sketchFeatureError({ ...point, kind: "polygon" })).toMatch(
      /needs Polygon geometry/,
    );
    expect(sketchFeatureError({ ...polygon, kind: "point" })).toMatch(
      /needs Point geometry/,
    );
    expect(sketchFeatureError({ ...polygon, kind: "line" })).toMatch(
      /needs LineString geometry/,
    );
  });

  it("refuses non-objects, unknown kinds, and missing geometry", () => {
    expect(sketchFeatureError(null)).toMatch(/kind and a geometry/);
    expect(sketchFeatureError({ kind: "star", geometry: point.geometry })).toMatch(
      /kind must be one of/,
    );
    expect(sketchFeatureError({ kind: "point" })).toMatch(/needs a geometry/);
  });

  it("refuses out-of-range and non-finite positions", () => {
    expect(
      sketchFeatureError({
        kind: "point",
        geometry: { type: "Point", coordinates: [181, 0] },
      }),
    ).not.toBeNull();
    expect(
      sketchFeatureError({
        kind: "point",
        geometry: { type: "Point", coordinates: [Number.NaN, 0] },
      }),
    ).not.toBeNull();
  });

  it("refuses an open ring, a short ring, and holes", () => {
    const open = ring(3);
    open.pop();
    expect(
      sketchFeatureError({
        kind: "polygon",
        geometry: { type: "Polygon", coordinates: [open] },
      }),
    ).toMatch(/closed ring/);
    expect(
      sketchFeatureError({
        kind: "polygon",
        geometry: { type: "Polygon", coordinates: [ring(2).slice(0, 3)] },
      }),
    ).not.toBeNull();
    expect(
      sketchFeatureError({
        kind: "polygon",
        geometry: { type: "Polygon", coordinates: [ring(3), ring(3)] },
      }),
    ).toMatch(/no holes/);
  });

  it("refuses a one-vertex line", () => {
    expect(
      sketchFeatureError({
        kind: "line",
        geometry: { type: "LineString", coordinates: [[0, 0]] },
      }),
    ).not.toBeNull();
  });

  it("holds the published ceiling — at it passes, past it refuses", () => {
    const at = {
      kind: "freehand",
      geometry: { type: "Polygon", coordinates: [ring(SKETCH_MAX_VERTICES - 1)] },
    };
    expect(sketchFeatureError(at)).toBeNull();
    const past = {
      kind: "freehand",
      geometry: { type: "Polygon", coordinates: [ring(SKETCH_MAX_VERTICES)] },
    };
    expect(sketchFeatureError(past)).toMatch(/at most/);
  });
});

describe("sketchVertexCount and WKT", () => {
  it("counts each family", () => {
    expect(sketchVertexCount(point.geometry as SketchGeometry)).toBe(1);
    expect(sketchVertexCount(line.geometry as SketchGeometry)).toBe(2);
    expect(sketchVertexCount(polygon.geometry as SketchGeometry)).toBe(4);
  });

  it("emits WKT per family", () => {
    expect(sketchGeometryWkt(point.geometry as SketchGeometry)).toBe(
      "POINT(13.4 52.5)",
    );
    expect(sketchGeometryWkt(line.geometry as SketchGeometry)).toBe(
      "LINESTRING(13.4 52.5, 13.5 52.6)",
    );
    expect(
      sketchGeometryWkt(polygon.geometry as SketchGeometry).startsWith(
        "POLYGON((",
      ),
    ).toBe(true);
  });
});
