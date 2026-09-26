import { describe, expect, it } from "vitest";
import { formatCell, fullValue, geometryLabel } from "./result-format";

describe("result cell formatting", () => {
  it("labels geometry objects briefly and keeps WKT strings as geometry", () => {
    expect(geometryLabel({ type: "Point", coordinates: [13.405123456, 52.52] })).toBe("POINT (13.40512 52.52)");
    expect(geometryLabel({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toBe("POLYGON (4 points)");
    expect(geometryLabel({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2]]] })).toBe("MULTILINESTRING (3 points)");
    expect(formatCell("POINT (1 2)")).toEqual({ text: "POINT (1 2)", kind: "geometry" });
    expect(formatCell({ type: "Point", coordinates: [1, 2] }).kind).toBe("geometry");
  });
  it("formats null, numbers, booleans and plain text", () => {
    expect(formatCell(null)).toEqual({ text: "NULL", kind: "null" });
    expect(formatCell(12345)).toEqual({ text: "12,345", kind: "number" });
    expect(formatCell(4.25)).toEqual({ text: "4.25", kind: "number" });
    expect(formatCell(true)).toEqual({ text: "true", kind: "text" });
    expect(formatCell("Mitte")).toEqual({ text: "Mitte", kind: "text" });
  });
  it("gives the peek the whole value", () => {
    expect(fullValue({ type: "Point", coordinates: [1, 2] })).toContain('"type": "Point"');
    expect(fullValue("x")).toBe("x");
  });
});
