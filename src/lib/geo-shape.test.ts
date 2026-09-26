import { describe, expect, it } from "vitest";
import {
  isPolygonalGeometry,
  geometryVertexCount,
  geometryParts,
  geometryWkt,
  geometryBbox,
} from "./geo-shape";

const square = [
  [8, 50],
  [9, 50],
  [9, 51],
  [8, 51],
  [8, 50],
];
const hole = [
  [8.4, 50.4],
  [8.6, 50.4],
  [8.6, 50.6],
  [8.4, 50.6],
  [8.4, 50.4],
];
const polygon = { type: "Polygon", coordinates: [square, hole] };
const multi = {
  type: "MultiPolygon",
  coordinates: [[square], [hole]],
};

describe("isPolygonalGeometry", () => {
  it("accepts polygons and multipolygons", () => {
    expect(isPolygonalGeometry(polygon)).toBe(true);
    expect(isPolygonalGeometry(multi)).toBe(true);
  });

  it("rejects other geometry types and malformed shapes", () => {
    expect(isPolygonalGeometry({ type: "Point", coordinates: [8, 50] })).toBe(
      false,
    );
    expect(
      isPolygonalGeometry({ type: "Polygon", coordinates: [square.slice(0, 3)] }),
    ).toBe(false);
    expect(
      isPolygonalGeometry({ type: "Polygon", coordinates: [[[200, 0], [0, 0], [1, 1], [200, 0]]] }),
    ).toBe(false);
    expect(isPolygonalGeometry(null)).toBe(false);
    expect(isPolygonalGeometry("POLYGON((0 0))")).toBe(false);
  });

  it("enforces the vertex budget", () => {
    expect(isPolygonalGeometry(polygon, 9)).toBe(false);
    expect(isPolygonalGeometry(polygon, 10)).toBe(true);
  });

  it("accepts positions carrying altitude", () => {
    const withAlt = {
      type: "Polygon",
      coordinates: [square.map(([lng, lat]) => [lng, lat, 12])],
    };
    expect(isPolygonalGeometry(withAlt)).toBe(true);
  });
});

describe("geometry helpers", () => {
  it("counts vertices across rings and parts", () => {
    expect(geometryVertexCount(polygon as never)).toBe(10);
    expect(geometryVertexCount(multi as never)).toBe(10);
  });

  it("splits parts into outer ring and holes", () => {
    const parts = geometryParts(polygon as never);
    expect(parts).toHaveLength(1);
    expect(parts[0].outer).toHaveLength(5);
    expect(parts[0].holes).toHaveLength(1);
    expect(geometryParts(multi as never)).toHaveLength(2);
  });

  it("builds WKT with holes preserved and rings closed", () => {
    expect(geometryWkt(polygon as never)).toBe(
      "POLYGON((8 50, 9 50, 9 51, 8 51, 8 50), (8.4 50.4, 8.6 50.4, 8.6 50.6, 8.4 50.6, 8.4 50.4))",
    );
    const open = {
      type: "Polygon",
      coordinates: [square.slice(0, 4)],
    };
    expect(geometryWkt(open as never)).toContain("8 50)");
    expect(geometryWkt(multi as never)).toMatch(/^MULTIPOLYGON\(\(\(/);
  });

  it("computes the bbox across all parts", () => {
    expect(geometryBbox(multi as never)).toEqual([8, 50, 9, 51]);
  });
});
