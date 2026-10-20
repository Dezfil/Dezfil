import { describe, it, expect } from "vitest";
import { boundsOf } from "./geo-bounds";

const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });
const point = (lng: number, lat: number) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
});
const polygon = (ring: [number, number][]) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring] },
});

describe("boundsOf", () => {
  it("returns null when there is no geometry", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([fc([])])).toBeNull();
  });

  it("bounds a set of points", () => {
    expect(boundsOf([fc([point(13.4, 52.5), point(2.35, 48.85)])])).toEqual([
      [2.35, 48.85],
      [13.4, 52.5],
    ]);
  });

  it("bounds the members of a geometry collection, nested ones too", () => {
    const collection = {
      type: "Feature",
      geometry: {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [10, 80] },
          { type: "GeometryCollection", geometries: [{ type: "LineString", coordinates: [[12, 81], [14, 79]] }] },
        ],
      },
    };
    expect(boundsOf([fc([collection])])).toEqual([
      [10, 79],
      [14, 81],
    ]);
    expect(boundsOf([fc([collection, point(-5, 40)])])).toEqual([
      [-5, 40],
      [14, 81],
    ]);
  });

  it("descends into nested polygon coordinates", () => {
    expect(
      boundsOf([
        fc([
          polygon([
            [0, 0],
            [10, 0],
            [10, 5],
            [0, 5],
            [0, 0],
          ]),
        ]),
      ]),
    ).toEqual([
      [0, 0],
      [10, 5],
    ]);
  });

  it("merges bounds across collections and ignores non-collections", () => {
    expect(
      boundsOf([fc([point(1, 1)]), null, "junk", fc([point(-3, 9)])]),
    ).toEqual([
      [-3, 1],
      [1, 9],
    ]);
  });
});
