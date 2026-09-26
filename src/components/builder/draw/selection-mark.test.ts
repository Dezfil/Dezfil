import { describe, expect, it } from "vitest";
import { CIRCLE_SEGMENTS, circleRing, rectangleRing } from "./draft-geometry";
import {
  POINT_MARK_PX,
  hasVertexHandles,
  selectionMarkFor,
  type Ground,
} from "./selection-mark";

// Real ground coordinates, around Berlin — the marks are asserted on the
// shapes' own positions, never on a stand-in.
const TRIANGLE: Ground[] = [
  [13.38, 52.52],
  [13.42, 52.52],
  [13.4, 52.5],
  [13.38, 52.52],
];
const LINE: Ground[] = [
  [13.3, 52.5],
  [13.35, 52.51],
  [13.4, 52.5],
];
const POINT: Ground = [13.405, 52.52];

describe("selectionMarkFor — every kind's mark follows its own geometry", () => {
  it("a polygon traces its ring, closed, with one handle per vertex", () => {
    const mark = selectionMarkFor("polygon", {
      type: "Polygon",
      coordinates: [TRIANGLE],
    });
    expect(mark).not.toBeNull();
    if (mark?.shape !== "outline") throw new Error("expected an outline");
    expect(mark.trace).toBe(TRIANGLE);
    expect(mark.closed).toBe(true);
    // The closing duplicate carries no handle of its own.
    expect(mark.handles).toEqual(TRIANGLE.slice(0, -1));
  });

  it("a freehand shape traces its ring as-is, however many vertices, and keeps its handles", () => {
    // Ten thousand vertices, the published ceiling: the mark must not
    // copy or densify what it traces (the plan's risk on freehand cost).
    const n = 10_000;
    const ring: Ground[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = (i / (n - 1)) * 2 * Math.PI;
      ring.push([13.4 + 0.01 * Math.cos(a), 52.5 + 0.01 * Math.sin(a)]);
    }
    ring.push(ring[0]);
    const mark = selectionMarkFor("freehand", {
      type: "Polygon",
      coordinates: [ring],
    });
    if (mark?.shape !== "outline") throw new Error("expected an outline");
    expect(mark.trace).toBe(ring);
    expect(mark.closed).toBe(true);
    expect(mark.handles).toHaveLength(n - 1);
    expect(mark.handles[0]).toEqual(ring[0]);
    expect(mark.handles[n - 2]).toEqual(ring[n - 2]);
  });

  it("a rectangle traces its four corners, closed, with no handle", () => {
    const ring = rectangleRing([13.38, 52.5], [13.42, 52.52]);
    const mark = selectionMarkFor("rectangle", {
      type: "Polygon",
      coordinates: [ring],
    });
    if (mark?.shape !== "outline") throw new Error("expected an outline");
    expect(mark.trace).toBe(ring);
    expect(mark.closed).toBe(true);
    expect(mark.handles).toEqual([]);
  });

  it("a circle traces its whole ring, closed, with no handle", () => {
    const ring = circleRing([13.4, 52.5], 0.5);
    const mark = selectionMarkFor("circle", {
      type: "Polygon",
      coordinates: [ring],
    });
    if (mark?.shape !== "outline") throw new Error("expected an outline");
    expect(mark.trace).toBe(ring);
    expect(mark.trace).toHaveLength(CIRCLE_SEGMENTS + 1);
    expect(mark.closed).toBe(true);
    expect(mark.handles).toEqual([]);
  });

  it("a line traces its path, open, with no handle", () => {
    const mark = selectionMarkFor("line", {
      type: "LineString",
      coordinates: LINE,
    });
    if (mark?.shape !== "outline") throw new Error("expected an outline");
    expect(mark.trace).toBe(LINE);
    expect(mark.closed).toBe(false);
    expect(mark.handles).toEqual([]);
  });

  it("a point's mark surrounds its position at a fixed screen radius", () => {
    const mark = selectionMarkFor("point", {
      type: "Point",
      coordinates: POINT,
    });
    expect(mark).toEqual({ shape: "point", position: POINT });
    // Wider than the rendered point (the sketch style's 4 px radius), so
    // the ring sits around it rather than on it.
    expect(POINT_MARK_PX).toBeGreaterThan(4);
  });

  it("refuses a kind whose geometry is not in its family, and an unknown kind", () => {
    expect(
      selectionMarkFor("circle", { type: "Point", coordinates: POINT }),
    ).toBeNull();
    expect(
      selectionMarkFor("point", { type: "LineString", coordinates: LINE }),
    ).toBeNull();
    expect(
      selectionMarkFor("line", { type: "Polygon", coordinates: [TRIANGLE] }),
    ).toBeNull();
    expect(
      selectionMarkFor("hexagon", { type: "Polygon", coordinates: [TRIANGLE] }),
    ).toBeNull();
  });
});

describe("hasVertexHandles —, unchanged", () => {
  it("is true for polygon and freehand only", () => {
    expect(hasVertexHandles("polygon")).toBe(true);
    expect(hasVertexHandles("freehand")).toBe(true);
    for (const kind of ["point", "line", "rectangle", "circle"])
      expect(hasVertexHandles(kind), kind).toBe(false);
  });
});
