import { expect, it } from "vitest";
import { withConnection } from "@/lib/duckdb";
import { degreeSql } from "./content-decoders";
import { lit } from "./sql";

it.each([
  ["POINT (180 90)", true], ["POINT (-180 -90)", true], ["POINT (180.00001 0)", false],
  ["LINESTRING (10 20, 180.00001 21, 11 22)", false], ["LINESTRING (10 20, 11 21)", true],
  ["POLYGON ((0 0, 5 5, 5 0, 0 5, 0 0))", true],
  ["POLYGON ((0 0, 180 0, 180 90, 0 90, 0 0), (1 1, 181 1, 1 2, 1 1))", false],
  ["GEOMETRYCOLLECTION (POINT (10 20), LINESTRING (1 2, -181 3))", false],
  ["POINT EMPTY", true], ["LINESTRING EMPTY", true], ["GEOMETRYCOLLECTION EMPTY", true],
])("degree safety preserves all vertex verdicts for %s", async (wkt, expected) => {
  await withConnection(async conn => {
    const row = (await conn.runAndReadAll(`SELECT ${degreeSql("g")} fits FROM (SELECT ST_GeomFromText(${lit(wkt)}) g)`)).getRowObjects()[0];
    expect(row.fits).toBe(expected);
  });
});

it.each([
  "ST_Point('Infinity'::DOUBLE, 20)",
  "ST_Point('NaN'::DOUBLE, 20)",
  "ST_MakeLine([ST_Point(10, 20), ST_Point('NaN'::DOUBLE, 21), ST_Point(11, 22)])",
])("degree safety rejects nonfinite vertices in %s", async g => {
  await withConnection(async conn => {
    const row = (await conn.runAndReadAll(`SELECT ${degreeSql("g")} fits FROM (SELECT ${g} g)`)).getRowObjects()[0];
    expect(row.fits).toBe(false);
  });
});
