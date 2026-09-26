import { describe, expect, it } from "vitest";
import type { GeometryCandidate, GeometryRecord } from "@/lib/geometry-evidence";
import type { DataTable } from "../api";
import { needsStep, stepTable } from "./needs-step";

/** A landed table as the upload answer carries it: the CSV road
 * always carries its evidence, every other road carries none. */
function landed(over: Partial<DataTable> = {}): DataTable {
  return {
    id: "t", name: "landed", sourceFilename: "landed.csv", format: "csv", file: "tables/t.parquet",
    geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 3,
    createdAt: "2026-09-13T10:00:00Z", source: "upload", sourceParams: null, importedAt: "2026-09-13T10:00:00Z",
    ...over,
  };
}
const weakPair: GeometryCandidate = {
  columns: ["a", "b"], format: "pair", signal: "content", rule: "content", strength: "weak",
  sample: { rows: 3, nonNull: 3, readable: 3 }, crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" },
  degreeCompatible: true, reasons: [], applied: false, sourceRetained: true, orientations: [{ lon: "a", lat: "b" }],
};
const applied: GeometryRecord = {
  columns: ["column01"], format: "wkt", signal: "content", rule: "content",
  crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0,
};

describe("the needs-step rule", () => {
  it("a CSV with weak candidates and no record stops", () => {
    expect(needsStep(landed({ geometryRecord: null, geometryCandidates: [weakPair] }))).toBe(true);
  });
  it("a CSV with no candidate at all stops too: default 1 is 'no strong match', not 'a weak one'", () => {
    expect(needsStep(landed({ geometryRecord: null, geometryCandidates: [] }))).toBe(true);
  });
  it("a strong match never stops: the record is applied and the table has its geometry", () => {
    expect(needsStep(landed({ geometryColumn: "geometry", geometryType: "LINESTRING", geometryRecord: applied, geometryCandidates: [{ ...weakPair, applied: true, strength: "strong" }] }))).toBe(false);
  });
  it("an answer without recognition evidence (every road but CSV) lands as today", () => {
    expect(needsStep(landed({ format: "geojson", sourceFilename: "districts.geojson", geometryColumn: "geometry", geometryType: "POLYGON" }))).toBe(false);
    expect(needsStep(landed({ format: "geojson", sourceFilename: "attributes.geojson" }))).toBe(false);
  });
  it("a container's several tables carry no evidence, so none stops; the first table needing a step is the one held", () => {
    expect(stepTable([landed({ name: "roads", format: "geopackage", geometryColumn: "geom" }), landed({ name: "notes", format: "geopackage" })])).toBeNull();
    const weak = landed({ name: "weak", geometryRecord: null, geometryCandidates: [weakPair] });
    expect(stepTable([landed({ name: "strong", geometryColumn: "geometry", geometryRecord: applied, geometryCandidates: [] }), weak])).toBe(weak);
    expect(stepTable([])).toBeNull();
  });
});
