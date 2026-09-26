import { describe, expect, it } from "vitest";
import { crsEvidence, decoderSql, placementStatsSql, presentSql, shapedFormats } from "./content-decoders";

it.each(["Point of interest", "LineString description", "POLYGON identifier", "POINTLESS (1 2)", "POINT Z description"])(
  "WKT pre-filter skips prose %s", value => {
    expect(shapedFormats([value])).not.toContain("wkt");
  },
);

it.each(["POINT(1 2)", " linestring (1 2, 3 4)", "POLYGON EMPTY", "POINT Z (1 2 3)", "POINT M EMPTY", "GEOMETRYCOLLECTION EMPTY", "SRID=4326;POINT (1 2)", "SRID=unknown;bad"])(
  "WKT pre-filter keeps geometry or CRS evidence %s", value => {
    expect(shapedFormats([value])).toContain("wkt");
  },
);

it.each([
  [4326, "WGS 84"],
  [3857, "Web Mercator (EPSG:3857)"],
  [25832, "ETRS89 / UTM 32N (EPSG:25832)"],
  [25833, "ETRS89 / UTM 33N (EPSG:25833)"],
  [3035, "ETRS89 / LAEA Europe (EPSG:3035)"],
  [27700, "British National Grid (EPSG:27700)"],
  [4269, "NAD83 (EPSG:4269)"],
  [31467, "EPSG:31467"],
] as const)("declared EPSG:%i uses the curated name or bare-code fallback", (srid, label) => {
  expect(crsEvidence("wkt", [srid])).toEqual({ stance: "declared", srid, label });
});

describe("the full-input placement pass (09-14)", () => {
  // Seeded defect: the shipped pass decoded the column twice, once as the
  // raw geometry and once inside the placed one, so a 325k-row WKT column
  // paid its parse twice on every inspection even with nothing to transform.
  const decode = decoderSql("wkt", ["column01"]);
  const count = (sql: string, needle: string) => sql.split(needle).length - 1;
  it("decodes the column once when the geometry is used as decoded, and checks the degree range once", () => {
    const sql = placementStatsSql("read_parquet('t.parquet')", presentSql(["column01"]), decode, null);
    expect(count(sql, "ST_GeomFromText")).toBe(1);
    expect(count(sql, "ST_Dump(ST_Points(")).toBe(1);
    for (const column of ["unreadable", "failed_transform", "source_unsafe", "unsafe"]) expect(sql).toContain(column);
  });
  it("decodes the column once under a transform, which is applied to the decoded geometry", () => {
    const sql = placementStatsSql("read_parquet('t.parquet')", presentSql(["column01"]), decode, (g) => `TRY(ST_Transform(${g}, 'EPSG:25833', 'EPSG:4326', always_xy := true))`);
    expect(count(sql, "ST_GeomFromText")).toBe(1);
    expect(sql).toContain("TRY(ST_Transform(raw_geometry, 'EPSG:25833'");
  });
});
