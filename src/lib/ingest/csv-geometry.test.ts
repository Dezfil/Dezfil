import { describe, it, expect } from "vitest";
import {
  recognizeCsvGeometry,
  geometryColumnName,
  suspectCsvHeader,
  type CsvColumn,
} from "./csv-geometry";

function cols(...pairs: [string, string][]): CsvColumn[] {
  return pairs.map(([name, type]) => ({ name, type }));
}

describe("recognizeCsvGeometry", () => {
  it("recognizes documented lon/lat pairs case-insensitively", () => {
    expect(
      recognizeCsvGeometry(cols(["LON", "DOUBLE"], ["Lat", "DOUBLE"])),
    ).toEqual({ kind: "point", lon: "LON", lat: "Lat" });
    expect(
      recognizeCsvGeometry(
        cols(["longitude", "DOUBLE"], ["latitude", "DOUBLE"], ["x", "DOUBLE"]),
      ),
    ).toEqual({ kind: "point", lon: "longitude", lat: "latitude" });
  });

  it("requires the pair to be numeric", () => {
    expect(
      recognizeCsvGeometry(cols(["lon", "VARCHAR"], ["lat", "DOUBLE"])),
    ).toBeNull();
  });

  it("accepts an exact-pair member when the reader found it all blank", () => {
    expect(
      recognizeCsvGeometry([
        { name: "lon", type: "DOUBLE" },
        { name: "lat", type: "VARCHAR", allBlank: true },
      ]),
    ).toEqual({ kind: "point", lon: "lon", lat: "lat" });
  });

  it.each([
    ["LoN", "lAt"],
    ["LnG", "LaT"],
    ["LoNg", "LAT"],
    ["LongItude", "LaTitude"],
  ])(
    "accepts the documented all-blank exact pair %s/%s case-insensitively",
    (lon, lat) => {
      expect(
        recognizeCsvGeometry([
          { name: lon, type: "VARCHAR", allBlank: true },
          { name: lat, type: "VARCHAR", allBlank: true },
        ]),
      ).toEqual({ kind: "point", lon, lat });
    },
  );

  it("recognizes a WKT text column and gives it precedence", () => {
    expect(
      recognizeCsvGeometry(
        cols(["wkt", "VARCHAR"], ["lon", "DOUBLE"], ["lat", "DOUBLE"]),
      ),
    ).toEqual({ kind: "wkt", column: "wkt" });
    expect(recognizeCsvGeometry(cols(["GEOM", "VARCHAR"]))).toEqual({
      kind: "wkt",
      column: "GEOM",
    });
  });

  it("does not treat a non-text geometry-named column as WKT", () => {
    expect(recognizeCsvGeometry(cols(["geometry", "DOUBLE"]))).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(
      recognizeCsvGeometry(cols(["name", "VARCHAR"], ["value", "BIGINT"])),
    ).toBeNull();
  });

  it("recognizes the origin pair of a flow table", () => {
    expect(
      recognizeCsvGeometry(
        cols(
          ["origin_lon", "DOUBLE"],
          ["origin_lat", "DOUBLE"],
          ["dest_lon", "DOUBLE"],
          ["dest_lat", "DOUBLE"],
          ["trips", "BIGINT"],
        ),
      ),
    ).toEqual({ kind: "point", lon: "origin_lon", lat: "origin_lat" });
  });

  it("holds a blank-qualified exact pair behind rule 3", () => {
    expect(
      recognizeCsvGeometry([
        { name: "lon", type: "VARCHAR", allBlank: true },
        { name: "lat", type: "VARCHAR", allBlank: true },
        { name: "origin_lon", type: "DOUBLE" },
        { name: "origin_lat", type: "DOUBLE" },
        { name: "dest_lon", type: "DOUBLE" },
        { name: "dest_lat", type: "DOUBLE" },
      ]),
    ).toEqual({ kind: "point", lon: "origin_lon", lat: "origin_lat" });
  });

  it("keeps a fully numeric exact pair ahead of rule 3", () => {
    expect(
      recognizeCsvGeometry(
        cols(
          ["lon", "DOUBLE"],
          ["lat", "DOUBLE"],
          ["origin_lon", "DOUBLE"],
          ["origin_lat", "DOUBLE"],
          ["dest_lon", "DOUBLE"],
          ["dest_lat", "DOUBLE"],
        ),
      ),
    ).toEqual({ kind: "point", lon: "lon", lat: "lat" });
  });

  it("recognizes a single prefixed pair outright", () => {
    expect(
      recognizeCsvGeometry(
        cols(["pickup_longitude", "DOUBLE"], ["pickup_latitude", "DOUBLE"]),
      ),
    ).toEqual({
      kind: "point",
      lon: "pickup_longitude",
      lat: "pickup_latitude",
    });
  });

  it("keeps all-blank prefixed pairs outside numeric-only rule 3", () => {
    expect(
      recognizeCsvGeometry([
        { name: "origin_lon", type: "VARCHAR", allBlank: true },
        { name: "origin_lat", type: "VARCHAR", allBlank: true },
      ]),
    ).toBeNull();
  });

  it("stays null for multiple unclassifiable prefixed pairs", () => {
    expect(
      recognizeCsvGeometry(
        cols(
          ["home_lon", "DOUBLE"],
          ["home_lat", "DOUBLE"],
          ["work_lon", "DOUBLE"],
          ["work_lat", "DOUBLE"],
        ),
      ),
    ).toBeNull();
  });
});

describe("geometryColumnName", () => {
  it("avoids collisions with existing columns", () => {
    expect(geometryColumnName(["name"])).toBe("geometry");
    expect(geometryColumnName(["Geometry", "geometry_2"])).toBe("geometry_3");
  });
});

describe("suspectCsvHeader ('s two signals)", () => {
  const names = (...ns: string[]) => ns.map((name) => ({ name }));

  it("unsplit header: a comma inside any detected name trips it", () => {
    // The field find's shape: the whole first line became one column.
    expect(
      suspectCsvHeader(names("56,JFK,-73.7781,40.6413,8477")),
    ).toBe(true);
    // Also among otherwise ordinary names.
    expect(suspectCsvHeader(names("region", "a,b", "count"))).toBe(true);
  });

  it("consumed header: a strict majority of numeric or blank names", () => {
    expect(
      suspectCsvHeader(names("56", "JFK", "-73.7781", "40.6413", "8477")),
    ).toBe(true);
    // Signs and decimals are plain numbers; blank means blank after
    // trimming.
    expect(suspectCsvHeader(names("+1", "-2.5", ".7", "  "))).toBe(true);
  });

  it("the majority is strict: half is not enough", () => {
    expect(suspectCsvHeader(names("region", "name", "2019", "2020"))).toBe(
      false,
    );
    expect(suspectCsvHeader(names("region", "2019", "2020"))).toBe(true);
  });

  it("plain numbers only: units, dates and mixed tokens do not count", () => {
    expect(
      suspectCsvHeader(names("10kg", "2020-01-01", "1e5", "a1")),
    ).toBe(false);
  });

  it("ordinary textual headers stay clean, and no columns stay clean", () => {
    expect(
      suspectCsvHeader(names("name", "lon", "lat", "category")),
    ).toBe(false);
    expect(suspectCsvHeader([])).toBe(false);
  });

  it("the named false positives do trip, as accepted at the gate", () => {
    // A legitimate quoted comma-bearing header name.
    expect(suspectCsvHeader(names("surname, firstname", "age"))).toBe(true);
    // A wide table of mostly year columns.
    expect(
      suspectCsvHeader(names("region", "2019", "2020", "2021")),
    ).toBe(true);
  });
});
