import { describe, expect, it } from "vitest";
import type { GeometryCandidate, GeometryRecord } from "@/lib/geometry-evidence";
import type { GeometryInspection } from "./types";
import { openingChoice } from "./opening-choice";
import { previewable, projectionFieldValue, requestChoice } from "./projection";

const column = (name: string, type = "VARCHAR") => ({ name, type });
const candidate = (over: Partial<GeometryCandidate>): GeometryCandidate => ({
  columns: ["column01"], format: "wkt", signal: "content", rule: "content", strength: "weak",
  sample: { rows: 20, nonNull: 20, readable: 17 }, crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" },
  degreeCompatible: true, reasons: [], applied: false, sourceRetained: true, ...over,
});
const inspection = (over: Partial<GeometryInspection>): GeometryInspection => ({
  tableId: "t", revision: "r", columns: [column("column00"), column("column01"), column("column06", "DOUBLE"), column("column07", "DOUBLE")],
  geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates: [], ...over,
});
const table = { geometryColumn: null as string | null, crsAssumed: false };
const declared: GeometryRecord = { columns: ["column01"], format: "wkt", signal: "manual", rule: "manual",
  crs: { stance: "declared", srid: 25833, label: "ETRS89 / UTM 33N (EPSG:25833)" }, unreadableCount: 0 };

describe("the opening choice", () => {
  it("a saved UTM pair reopens with its code in the field and in the request, not WGS 84", () => {
    const opened = openingChoice({
      inspection: inspection({ geometryColumn: "geometry", currentChoice: { format: "pair", columns: ["column07", "column06"], epsg: 25833 }, candidates: [candidate({})] }),
      table: { geometryColumn: "geometry", crsAssumed: false },
    });
    expect(opened.mode).toBe("change");
    expect(opened.choice.columns).toEqual(["column07", "column06"]);
    expect(projectionFieldValue(opened.choice, null)).toEqual({ value: "25833", text: "" });
    expect(requestChoice(opened.choice)).toEqual({ format: "pair", columns: ["column07", "column06"], epsg: 25833 });
    expect(opened.marked).toBe(false);
  });
  it("a saved explicit 4326 stays declared on reopen; a saved implicit choice sends no code", () => {
    const explicit = openingChoice({ inspection: inspection({ geometryColumn: "geometry", currentChoice: { format: "wkt", columns: ["column01"], epsg: 4326 } }), table: { geometryColumn: "geometry", crsAssumed: false } });
    expect(requestChoice(explicit.choice)).toEqual({ format: "wkt", columns: ["column01"], epsg: 4326 });
    const implicit = openingChoice({ inspection: inspection({ geometryColumn: "geometry", currentChoice: { format: "wkt", columns: ["column01"] } }), table: { geometryColumn: "geometry", crsAssumed: true } });
    expect(requestChoice(implicit.choice)).toEqual({ format: "wkt", columns: ["column01"] });
    expect(projectionFieldValue(implicit.choice, null)).toEqual({ value: "4326", text: "" });
  });
  it("the current choice wins over the candidates and over the first format", () => {
    const opened = openingChoice({
      inspection: inspection({ geometryColumn: "geometry", currentChoice: { format: "wkb", columns: ["column00"] }, candidates: [candidate({ columns: ["column01"] })] }),
      table: { geometryColumn: "geometry", crsAssumed: true },
    });
    expect(opened.choice.format).toBe("wkb");
    expect(opened.choice.columns).toEqual(["column00"]);
  });
  it("a recordless assumed native dataset opens on its geometry column as WKB hex, marked, and sends no preview", () => {
    const opened = openingChoice({
      inspection: inspection({ columns: [column("id", "BIGINT"), column("geometry", "GEOMETRY")], geometryColumn: "geometry", candidates: [] }),
      table: { geometryColumn: "geometry", crsAssumed: true },
    });
    expect(opened.choice).toMatchObject({ format: "wkb", columns: ["geometry"], projection: { kind: "unset", code: null } });
    expect(opened.marked).toBe(true);
    expect(opened.mode).toBe("change");
    expect(previewable(opened.choice)).toBe(false);
    expect(projectionFieldValue(opened.choice, null)).toEqual({ value: "", text: "" });
  });
  it("consumed named WKT opens on the geometry column with the record's format, marked", () => {
    const record: GeometryRecord = { columns: ["wkt"], format: "wkt", signal: "name", rule: "wkt-name", crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0 };
    const opened = openingChoice({
      inspection: inspection({ columns: [column("name"), column("geometry", "GEOMETRY")], geometryColumn: "geometry", geometryRecord: record, candidates: [candidate({ columns: ["name"] })] }),
      table: { geometryColumn: "geometry", crsAssumed: true },
    });
    expect(opened.choice).toMatchObject({ format: "wkt", columns: ["geometry"], projection: { kind: "unset" } });
    expect(previewable(opened.choice)).toBe(false);
  });
  it("without a current choice the first candidate in the API's order opens, a pair in its first orientation, a consumed source skipped", () => {
    const opened = openingChoice({
      inspection: inspection({ candidates: [
        candidate({ columns: ["gone"], sourceRetained: false }),
        candidate({ columns: ["column06", "column07"], format: "pair", orientations: [{ lon: "column07", lat: "column06" }, { lon: "column06", lat: "column07" }] }),
        candidate({ columns: ["column01"] }),
      ] }),
      table,
    });
    expect(opened.choice).toMatchObject({ format: "pair", columns: ["column07", "column06"], projection: { kind: "implicit" } });
    expect(opened.mode).toBe("first");
    expect(previewable(opened.choice)).toBe(true);
  });
  it("with nothing to open on, the first format takes the first accepted columns in column order; a one-column text table falls to WKT", () => {
    const pair = openingChoice({ inspection: inspection({}), table });
    expect(pair.choice).toMatchObject({ format: "pair", columns: ["column00", "column01"] });
    const text = openingChoice({ inspection: inspection({ columns: [column("payload")] }), table });
    expect(text.choice).toMatchObject({ format: "wkt", columns: ["payload"] });
    const nothing = openingChoice({ inspection: inspection({ columns: [column("n", "BIGINT")] }), table });
    expect(nothing.choice.columns).toEqual([]);
    expect(previewable(nothing.choice)).toBe(false);
  });
  it("a corrected consumed dataset with nothing else to offer opens on its stored column, so the API's refusal is reachable", () => {
    const record: GeometryRecord = { columns: ["wkt"], format: "wkt", signal: "manual", rule: "manual", crs: { stance: "declared", srid: 25833, label: "ETRS89 / UTM 33N (EPSG:25833)" }, unreadableCount: 0 };
    const opened = openingChoice({
      inspection: inspection({ columns: [column("id", "BIGINT"), column("geometry", "GEOMETRY")], geometryColumn: "geometry", geometryRecord: record, candidates: [] }),
      table: { geometryColumn: "geometry", crsAssumed: false },
    });
    expect(opened.choice).toMatchObject({ format: "wkt", columns: ["geometry"], projection: { kind: "implicit" } });
    expect(opened.marked).toBe(false);
    expect(previewable(opened.choice)).toBe(true);
    expect(projectionFieldValue(opened.choice, record)).toEqual({ value: "25833", text: "" });
  });
  it("an unlisted saved code opens Other with the code in its field and still sends it", () => {
    const opened = openingChoice({ inspection: inspection({ geometryColumn: "geometry", currentChoice: { format: "pair", columns: ["column07", "column06"], epsg: 31467 } }), table: { geometryColumn: "geometry", crsAssumed: false } });
    expect(projectionFieldValue(opened.choice, null)).toEqual({ value: "other", text: "31467" });
    expect(requestChoice(opened.choice).epsg).toBe(31467);
  });
  it("an implicit choice shows a declared record's CRS in the field and sends nothing", () => {
    const opened = openingChoice({ inspection: inspection({ geometryColumn: "geometry", geometryRecord: declared, currentChoice: { format: "wkt", columns: ["column01"] } }), table: { geometryColumn: "geometry", crsAssumed: false } });
    expect(projectionFieldValue(opened.choice, declared)).toEqual({ value: "25833", text: "" });
    expect(requestChoice(opened.choice)).not.toHaveProperty("epsg");
  });
  it("a seeded pair from the proposal strip opens filled in, implicit, as a first apply", () => {
    const opened = openingChoice({ inspection: inspection({ candidates: [candidate({})] }), table, seed: { format: "pair", columns: ["column07", "column06"] } });
    expect(opened.choice).toMatchObject({ format: "pair", columns: ["column07", "column06"], projection: { kind: "implicit" } });
    expect(opened.mode).toBe("first");
  });
});
