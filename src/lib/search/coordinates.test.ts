import { describe, it, expect } from "vitest";
import { parseCoordinates } from "./coordinates";

describe("pasted decimal pairs", () => {
  it("offers both readings when both are plausible", () => {
    expect(parseCoordinates("52.5, 13.4")).toEqual([
      { reading: "latlon", lat: 52.5, lng: 13.4 },
      { reading: "lonlat", lat: 13.4, lng: 52.5 },
    ]);
  });

  it("offers only the valid reading when one is out of range", () => {
    expect(parseCoordinates("120, 45")).toEqual([
      { reading: "lonlat", lat: 45, lng: 120 },
    ]);
    expect(parseCoordinates("45, 120")).toEqual([
      { reading: "latlon", lat: 45, lng: 120 },
    ]);
  });

  it("offers nothing when neither reading is valid", () => {
    expect(parseCoordinates("200, 95")).toEqual([]);
  });

  it("collapses the transposed reading of an equal pair", () => {
    expect(parseCoordinates("10, 10")).toEqual([
      { reading: "latlon", lat: 10, lng: 10 },
    ]);
  });

  it("reads negative and whitespace-separated pairs", () => {
    expect(parseCoordinates("-33.9 151.2")).toEqual([
      { reading: "latlon", lat: -33.9, lng: 151.2 },
    ]);
  });

  it("rejects everything that is not a bare decimal pair", () => {
    for (const text of [
      "berlin",
      "52.5",
      "52.5, 13.4, 7",
      "52.5N 13.4E",
      "52,5 13,4", // comma decimals read as four fields, not a pair
      "",
    ]) {
      expect(parseCoordinates(text)).toEqual([]);
    }
  });
});
