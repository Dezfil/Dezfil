import { describe, expect, it } from "vitest";
import { layerContainsPatch, mapContainsPatch } from "./layer-patch";

describe("layer PATCH recovery", () => {
  it("accepts server-derived fields that were absent from the request", () => {
    const layer = {
      viz: {
        type: "grid",
        cellKm: 2,
        aggregate: { fn: "count" },
        fill: {
          type: "quantile",
          attribute: "value",
          breaks: [2, 4],
          colors: ["a", "b", "c"],
        },
      },
    };

    expect(
      layerContainsPatch(layer, {
        viz: { type: "grid", cellKm: 2, aggregate: { fn: "count" } },
      }),
    ).toBe(true);
  });

  it("requires arrays and requested scalar values to match exactly", () => {
    const layer = {
      filters: [{ field: "value", kind: "range", min: 10, max: 20 }],
    };

    expect(layerContainsPatch(layer, layer)).toBe(true);
    expect(
      layerContainsPatch(layer, {
        filters: [{ field: "value", kind: "range", min: 11, max: 20 }],
      }),
    ).toBe(false);
    expect(
      layerContainsPatch(layer, {
        filters: [
          { field: "value", kind: "range", min: 10, max: 20 },
          { field: "other", kind: "range", min: null, max: null },
        ],
      }),
    ).toBe(false);
  });
});

describe("map PATCH recovery", () => {
  it("accepts requested fields present in the authoritative map", () => {
    const map = { name: "Renamed", basemap: "dark", widgets: [] };
    expect(mapContainsPatch(map, { name: "Renamed" })).toBe(true);
    expect(mapContainsPatch(map, { name: "Other" })).toBe(false);
    expect(mapContainsPatch(map, { legendCorner: "top-left" })).toBe(false);
  });

  it("reads layerOrder off the embedded layer list", () => {
    const map = { layers: [{ id: "b" }, { id: "a" }] };
    expect(mapContainsPatch(map, { layerOrder: ["b", "a"] })).toBe(true);
    expect(mapContainsPatch(map, { layerOrder: ["a", "b"] })).toBe(false);
    expect(mapContainsPatch({ layers: [] }, { layerOrder: ["a"] })).toBe(
      false,
    );
  });
});
