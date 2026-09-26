import { describe, expect, it } from "vitest";
import { inferOd, lonLatPairs, odCandidates, odPossible } from "./od";

describe("lon/lat pair detection", () => {
  it("pairs columns by shared stem across naming styles", () => {
    expect(
      lonLatPairs(["origin_lon", "origin_lat", "dest_lng", "dest_lat", "trips"]),
    ).toEqual([
      { lon: "origin_lon", lat: "origin_lat", stem: "origin" },
      { lon: "dest_lng", lat: "dest_lat", stem: "dest" },
    ]);
    expect(lonLatPairs(["pickup_longitude", "pickup_latitude"])).toEqual([
      { lon: "pickup_longitude", lat: "pickup_latitude", stem: "pickup" },
    ]);
    expect(lonLatPairs(["lon", "lat"])).toEqual([
      { lon: "lon", lat: "lat", stem: "" },
    ]);
  });

  it("ignores unpaired and ambiguous coordinate columns", () => {
    expect(lonLatPairs(["origin_lon", "dest_lat", "trips"])).toEqual([]);
    // A column with both tokens is not a coordinate role.
    expect(lonLatPairs(["lon_lat_ratio", "value"])).toEqual([]);
  });
});

describe("endpoint inference", () => {
  it("maps exactly two geometry columns by SELECT order", () => {
    expect(
      inferOd({ geometryColumns: ["a_geom", "b_geom"], numericColumns: [] }),
    ).toEqual({
      origin: { kind: "geometry", field: "a_geom" },
      dest: { kind: "geometry", field: "b_geom" },
    });
  });

  it("matches name conventions over geometry fields first", () => {
    expect(
      inferOd({
        geometryColumns: ["geometry", "start_geom", "end_geom"],
        numericColumns: [],
      }),
    ).toEqual({
      origin: { kind: "geometry", field: "start_geom" },
      dest: { kind: "geometry", field: "end_geom" },
    });
  });

  it("falls back to named numeric pairs — the flow-CSV case", () => {
    expect(
      inferOd({
        geometryColumns: ["geometry"],
        numericColumns: [
          "origin_lon",
          "origin_lat",
          "dest_lon",
          "dest_lat",
          "trips",
        ],
      }),
    ).toEqual({
      origin: { kind: "lonlat", lon: "origin_lon", lat: "origin_lat" },
      dest: { kind: "lonlat", lon: "dest_lon", lat: "dest_lat" },
    });
  });

  it("mixes a named geometry origin with a named pair destination", () => {
    expect(
      inferOd({
        geometryColumns: ["from_geom"],
        numericColumns: ["to_lon", "to_lat"],
      }),
    ).toEqual({
      origin: { kind: "geometry", field: "from_geom" },
      dest: { kind: "lonlat", lon: "to_lon", lat: "to_lat" },
    });
  });

  it("stays unmapped when the columns are ambiguous", () => {
    expect(
      inferOd({ geometryColumns: ["geometry"], numericColumns: ["x", "y"] }),
    ).toBeNull();
    expect(
      inferOd({
        geometryColumns: ["a", "b", "c"],
        numericColumns: [],
      }),
    ).toBeNull();
  });
});

describe("tile availability", () => {
  it("needs two expressible endpoints", () => {
    expect(
      odPossible({ geometryColumns: ["geometry"], numericColumns: ["riders"] }),
    ).toBe(false);
    expect(
      odPossible({ geometryColumns: ["a", "b"], numericColumns: [] }),
    ).toBe(true);
    expect(
      odPossible({
        geometryColumns: ["geometry"],
        numericColumns: ["dest_lon", "dest_lat"],
      }),
    ).toBe(true);
  });

  it("candidates list geometry columns before pairs", () => {
    expect(
      odCandidates({
        geometryColumns: ["geometry"],
        numericColumns: ["to_lon", "to_lat"],
      }),
    ).toEqual([
      { kind: "geometry", field: "geometry" },
      { kind: "lonlat", lon: "to_lon", lat: "to_lat" },
    ]);
  });
});
