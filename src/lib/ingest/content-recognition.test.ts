import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withConnection } from "@/lib/duckdb";
import { buildArtifact, ident, lit, type ArtifactMeta } from "./ingest";

let dir: string;
let sequence = 0;
beforeEach(async () => { dir = await mkdtemp(path.join(process.cwd(), ".tmp-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// The expected public evidence, independent of the detector's implementation.
interface Candidate {
  columns: string[];
  format: string;
  signal: string;
  strength: string;
  sample: { rows: number; nonNull: number; readable: number | null };
  reasons: string[];
  orientations?: { lon: string; lat: string }[];
  applied: boolean;
}
interface Evidence {
  geometryRecord: { columns: string[]; format: string; unreadableCount: number; crs: { stance: string; srid: number | null } } | null;
  geometryCandidates: Candidate[];
}
async function convert(headers: string[], rows: (string | number | null)[][]) {
  const csv = [headers, ...rows].map(r => r.map(v => v === null ? "" : '"' + String(v).replaceAll('"', '""') + '"').join(",")).join("\n") + "\n";
  return convertBytes(csv);
}
async function convertBytes(csv: string) {
  const src = path.join(dir, `input-${sequence++}.csv`);
  const artifact = src + ".parquet";
  await writeFile(src, csv);
  const meta = await buildArtifact(src, "input.csv", artifact) as ArtifactMeta & Evidence;
  const data = await withConnection(async conn => {
    const projection = meta.geometryColumn
      ? `* EXCLUDE (${ident(meta.geometryColumn)}), ${meta.geometryType ? `ST_AsText(${ident(meta.geometryColumn)})` : "NULL::VARCHAR"} AS shape`
      : "*";
    return (await conn.runAndReadAll(`SELECT ${projection} FROM read_parquet(${lit(artifact)})`)).getRowObjects();
  });
  return { meta, data, artifact };
}

const wkb = "010100000000000000000024400000000000003440"; // POINT (10 20)
const ewkb = "0101000020110F00009F476EE86AFC30410000000000000000"; // EPSG:3857, POINT (1113194.9079327357 0)
const formats = [
  ["wkt", "POINT (10 20)", "POINT (10 20)", "assumed"],
  ["wkt", "SRID=4326;POINT (10 20)", "POINT (10 20)", "declared"],
  ["geojson", '{"type":"Point","coordinates":[10,20]}', "POINT (10 20)", "inherent"],
  ["wkb", wkb, "POINT (10 20)", "assumed"],
  ["h3", "8928308280fffff", "POLYGON", "inherent"],
] as const;

describe("content recognition through the CSV reader", () => {
  it("recognizes the eleven-column headerless trajectories fixture and keeps both endpoint alternatives", async () => {
    const { meta, data } = await convertBytes(await readFile(path.join(process.cwd(), "src/lib/ingest/fixtures/trajectories.csv"), "utf8"));
    expect(meta).toMatchObject({ geometryType: "LINESTRING", rowCount: 3, headerSuspect: false, geometryRecord: { columns: ["column01"], format: "wkt", unreadableCount: 0 } });
    expect(data[0]).toMatchObject({ column00: "aabbccddeeff00112233445566778899", column01: "LINESTRING (8.5717 50.0492, 8.572175 50.0492)", column04: 8.5717, column05: 50.0492, column06: 8.572175, column07: 50.0492, column08: 7n, column10: "route-a", shape: "LINESTRING (8.5717 50.0492, 8.572175 50.0492)" });
    for (const columns of [["column04", "column05"], ["column06", "column07"]]) {
      expect(meta.geometryCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ columns, format: "pair", strength: "weak", orientations: [{ lon: columns[0], lat: columns[1] }, { lon: columns[1], lat: columns[0] }] })]));
    }
    expect(Object.keys(data[0])).toHaveLength(12);
    expect(String(data[0].column02)).toBe("2026-09-01 08:00:00");
    expect(String(data[0].column03)).toBe("2026-09-01 08:30:00");
  });

  it.each(formats)("arbitrary column reads %s (%s)", async (format, value, shape, stance) => {
    const { meta, data } = await convert(["payload", "label"], [[value, "a"], [value, "b"]]);
    expect(meta).toMatchObject({ crsAssumed: stance === "assumed", geometryRecord: { columns: ["payload"], format, crs: { stance }, unreadableCount: 0 } });
    expect(data[0].payload).toBe(value);
    expect(String(data[0].shape)).toContain(shape);
    if (format === "h3") {
      // Independent known San Francisco cell: polygon is tiny and in this box.
      const numbers = String(data[0].shape).match(/-?\d+\.\d+/g)!.map(Number);
      expect(numbers.length).toBe(14);
      for (let i = 0; i < numbers.length; i += 2) {
        expect(numbers[i]).toBeGreaterThan(-122.422);
        expect(numbers[i]).toBeLessThan(-122.415);
        expect(numbers[i + 1]).toBeGreaterThan(37.774);
        expect(numbers[i + 1]).toBeLessThan(37.780);
      }
    }
  });

  // The second H3-shaped invalid cell still has a decodable boundary without validation.
  it.each(["aabbccddeeff00112233445566778899", "fffffffffffffff", "8ffffffffffffff", "8928308280ffffe", '{"type":"Feature","geometry":{"type":"Point","coordinates":[10,20]}}', '{"type":"FeatureCollection","features":[]}'])("rejects format lookalike %s", async value => {
    const { meta } = await convert(["payload", "label"], [[value, "a"], [value, "b"]]);
    expect(meta).toMatchObject({ geometryColumn: null, crsAssumed: false, geometryRecord: null, geometryCandidates: [] });
  });

  it.each([20, 19, 18, 10, 9, 1])("%i/20 sampled readable values require unanimity for auto-apply", async n => {
    const { meta } = await convert(["payload", "label"], Array.from({ length: 20 }, (_, i) => [i < n ? "POINT (10 20)" : "bad", "a"]));
    expect(meta.geometryColumn !== null).toBe(n === 20);
    expect(meta.geometryCandidates).toEqual([expect.objectContaining({ strength: n === 20 ? "strong" : "weak", sample: { rows: 20, nonNull: 20, readable: n } })]);
  });

  it("NULLs leave the denominator; zero and one valid row have distinct outcomes", async () => {
    const empty = await convert(["payload", "label"], [[null, "a"], [null, "b"]]);
    expect(empty.meta).toMatchObject({ geometryColumn: null, geometryCandidates: [] });
    const one = await convert(["payload", "label"], [[null, "a"], ["POINT (10 20)", "b"]]);
    expect(one.meta.geometryCandidates[0]).toMatchObject({ strength: "strong", sample: { rows: 2, nonNull: 1, readable: 1 } });
    expect(one.data.map(r => r.shape)).toEqual([null, "POINT (10 20)"]);
  });

  it("first 1000 reader rows score strength but unreadable totals include the tail", async () => {
    const { meta, data } = await convert(["payload", "label"], [...Array.from({ length: 1000 }, () => ["POINT (10 20)", "a"]), ["bad", "b"], [null, "c"]]);
    expect(meta).toMatchObject({ rowCount: 1002, geometryRecord: { unreadableCount: 1 } });
    expect(meta.geometryCandidates[0].sample).toEqual({ rows: 1000, nonNull: 1000, readable: 1000 });
    expect(data.slice(-2).map(r => r.shape)).toEqual([null, null]);
    const firstMissing = await convert(["payload", "label"], [...Array.from({ length: 1000 }, () => [null, "a"]), ["POINT (10 20)", "b"]]);
    expect(firstMissing.meta).toMatchObject({ geometryColumn: null, geometryCandidates: [] });
  });

  it("names precede content, rejected names yield to later safe names, and strong columns keep source order", async () => {
    const names = await convert(["payload", "wkt", "lon", "lat"], [["POINT (1 2)", "POINT (10 20)", 30, 40]]);
    expect(names.meta.geometryRecord?.columns).toEqual(["wkt"]);
    expect(names.data[0]).not.toHaveProperty("wkt");
    expect(names.meta.geometryCandidates.some(c => c.columns[0] === "payload" && !c.applied)).toBe(true);
    const next = await convert(["wkt", "geom", "payload"], [["POINT (500 1000)", "POINT (10 20)", "POINT (1 2)"]]);
    expect(next.meta.geometryRecord?.columns).toEqual(["geom"]);
    const content = await convert(["second", "first"], [["POINT (30 40)", "POINT (10 20)"]]);
    expect(content.meta.geometryRecord?.columns).toEqual(["second"]);
    expect(content.meta.geometryCandidates.map(c => c.columns)).toEqual([["second"], ["first"]]);
  });

  it("weak alternatives order formats, named pairs, share, adjacency and source columns", async () => {
    const { meta } = await convert(["sparse", "dense", "x", "y", "m", "n"], [
      ["POINT (1 2)", "POINT (3 4)", 10, 20, 30, 40],
      ["bad", "POINT (5 6)", 11, 21, 31, 41],
      ["bad", "bad", 12, 22, 32, 42],
    ]);
    expect(meta.geometryColumn).toBeNull();
    expect(meta.geometryCandidates.map(c => c.columns)).toEqual([
      ["dense"], ["sparse"], ["x", "y"], ["y", "m"], ["m", "n"],
      ["x", "m"], ["x", "n"], ["y", "n"],
    ]);
    expect(meta.geometryCandidates.slice(0, 2).map(c => c.sample.readable)).toEqual([2, 1]);
    expect(meta.geometryCandidates.every(c => c.strength === "weak")).toBe(true);
  });

  it.each([
    ["geom", "wkb", wkb, "assumed"],
    ["geometry", "geojson", '{"type":"Point","coordinates":[10,20]}', "inherent"],
    ["wkt", "wkb", wkb, "assumed"],
  ])("unreadable named %s yields to %s content without consuming its source", async (column, format, value, stance) => {
    const { meta, data } = await convert([column, "label"], [[value, "a"], [null, "b"]]);
    expect(meta).toMatchObject({ geometryType: "POINT", rowCount: 2, crsAssumed: stance === "assumed",
      geometryRecord: { columns: [column], format, signal: "content", crs: { stance }, unreadableCount: 0 } });
    expect(data).toEqual([{ [column]: value, label: "a", shape: "POINT (10 20)" }, { [column]: null, label: "b", shape: null }]);
    expect(meta.geometryCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ columns: [column], format: "wkt", signal: "name", strength: "weak",
        sample: { rows: 2, nonNull: 1, readable: 0 }, reasons: ["unreadable"], applied: false, sourceRetained: true }),
      expect.objectContaining({ columns: [column], format, signal: "content", strength: "strong", applied: true, sourceRetained: true }),
    ]));
  });

  it("an unreadable named WKT yields to the next eligible name before content", async () => {
    const { meta, data } = await convert(["geom", "lon", "lat"], [[wkb, 30, 40]]);
    expect(meta.geometryRecord).toMatchObject({ columns: ["lon", "lat"], format: "pair", signal: "name" });
    expect(data[0]).toMatchObject({ geom: wkb, shape: "POINT (30 40)" });
  });

  it.each([["pickup_x", "pickup_y"], ["lon", "lat"], ["origin_lon", "origin_lat"]])("safe named %s/%s applies; projected stays weak", async (lon, lat) => {
    const safe = await convert([lon, lat, "label"], [[10, 20, "a"]]);
    expect(safe.meta.geometryRecord).toMatchObject({ columns: [lon, lat], format: "pair" });
    const projected = await convert([lon, lat, "label"], [[500000, 5800000, "a"]]);
    expect(projected.meta).toMatchObject({ geometryColumn: null, crsAssumed: false });
    expect(projected.meta.geometryCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ columns: [lon, lat], strength: "weak", reasons: expect.arrayContaining(["outside-degree-range"]) })]));
  });

  it.each([["x", "y"], ["easting", "northing"], ["a", "b"]])("numeric %s/%s always weak", async (x, y) => {
    const { meta } = await convert([x, y, "label"], [[10, 20, "a"], [30, 40, "b"]]);
    expect(meta).toMatchObject({ geometryColumn: null, crsAssumed: false });
    expect(meta.geometryCandidates[0]).toMatchObject({ columns: [x, y], strength: "weak" });
    const projected = await convert([x, y, "label"], [[500000, 5800000, "a"]]);
    expect(projected.meta).toMatchObject({ geometryColumn: null, crsAssumed: false });
    if (x !== "a") expect(projected.meta.geometryCandidates[0]).toMatchObject({
      columns: [x, y], strength: "weak", reasons: expect.arrayContaining(["outside-degree-range"]),
    });
  });

  it("full-input placement rejects a projected tail and accepts inclusive degree edges", async () => {
    for (const [headers, safe, bad] of [
      [["payload", "label"], ["POINT (10 20)", "a"], ["POINT (181 20)", "b"]],
      [["lon", "lat"], [10, 20], [10, 91]],
    ] as const) {
      const { meta } = await convert([...headers], [...Array.from({ length: 1000 }, () => [...safe]), [...bad]]);
      expect(meta).toMatchObject({ geometryColumn: null, crsAssumed: false });
      expect(meta.geometryCandidates[0].reasons).toContain("outside-degree-range");
    }
    const edges = await convert(["payload", "label"], [["LINESTRING (-180 -90, 180 90)", "a"]]);
    expect(edges.meta.geometryType).toBe("LINESTRING");
  });

  it.each(["SRID=3857;POINT (1113194.9079327357 0)", ewkb])("a consistent declared projected CRS reprojects %s", async value => {
    const { meta, data } = await convert(["payload", "label"], [[value, "a"]]);
    expect(meta).toMatchObject({ crsAssumed: false, geometryRecord: { crs: { stance: "declared", srid: 3857 } } });
    expect(data[0].shape).toBe("POINT (10 0)");
    // Candidate evidence describes the retained source, not its projected output.
    expect(meta.geometryCandidates[0]).toMatchObject({ strength: "strong", degreeCompatible: false });
  });

  it.each([
    ["SRID=4326;POINT (10 20)", "SRID=3857;garbage", "conflicting-crs"],
    ["SRID=unknown;POINT (10 20)", "SRID=unknown;POINT (11 21)", "unknown-crs"],
    ["SRID=999999;POINT (10 20)", "SRID=999999;POINT (11 21)", "untransformable-crs"],
  ])("keeps unsafe declarations weak independently of decoding (%s)", async (a, b, reason) => {
    const { meta } = await convert(["wkt", "label"], [[a, "a"], [b, "b"]]);
    expect(meta).toMatchObject({ geometryColumn: null, crsAssumed: false });
    expect(meta.geometryCandidates[0].reasons).toContain(reason);
  });

  it("selected named WKT bad and missing values keep rows with exact counts, including whitespace", async () => {
    const { meta, data } = await convert(["wkt", "label"], [["POINT (1 2)", "a"], ["bad", "b"], [null, "c"], [" ", "d"]]);
    expect(meta).toMatchObject({ rowCount: 4, geometryType: "POINT", geometryRecord: { unreadableCount: 2 } });
    expect(data.map(r => r.shape)).toEqual(["POINT (1 2)", null, null, null]);
  });

  it.each(["wkt", "geometry", "geom"])("all-unreadable named %s stays a retained weak candidate in a plain table", async column => {
    const { meta, data } = await convert([column, "label"], [["bad", "a"], [" ", "b"], [null, "c"]]);
    expect(meta).toMatchObject({ geometryColumn: null, geometryType: null, rowCount: 3, crsAssumed: false, geometryRecord: null });
    expect(meta.geometryCandidates).toEqual([expect.objectContaining({ columns: [column], format: "wkt", strength: "weak",
      sample: { rows: 3, nonNull: 2, readable: 0 }, reasons: ["unreadable"], applied: false, sourceRetained: true })]);
    expect(data).toEqual([{ [column]: "bad", label: "a" }, { [column]: " ", label: "b" }, { [column]: null, label: "c" }]);
  });

  it.each(formats)("tolerant %s decoding counts bad tail rows", async (_format, value) => {
    const { meta, data } = await convert(["payload", "label"], [...Array.from({ length: 1000 }, () => [value, "a"]), ["bad", "b"], [null, "c"]]);
    expect(meta.geometryRecord?.unreadableCount).toBe(1);
    expect(data.slice(-2).map(r => r.shape)).toEqual([null, null]);
  });

  it("automatic WKB decoding keeps blank and whitespace tail cells as missing geometry", async () => {
    const { meta, data } = await convert(["payload", "label"], [
      ...Array.from({ length: 1000 }, () => [wkb, "a"]),
      ["", "blank"], ["   ", "spaces"], [null, "missing"],
    ]);
    expect(meta).toMatchObject({ rowCount: 1003, geometryType: "POINT", geometryRecord: { format: "wkb", unreadableCount: 1 } });
    expect(data.slice(-3).map(row => row.shape)).toEqual([null, null, null]);
  });

  it("mixed geometry classification and full extent survive the content road", async () => {
    const { meta, artifact } = await convert(["payload", "label"], [["POINT (1 2)", "a"], ["LINESTRING (100 60, 120 70)", "b"]]);
    expect(meta.geometryType).toBe("POINT+LINESTRING");
    const bounds = await withConnection(async conn => (await conn.runAndReadAll(`SELECT max(ST_XMax(geometry)) x, max(ST_YMax(geometry)) y FROM read_parquet(${lit(artifact)})`)).getRowObjects());
    expect(bounds).toEqual([{ x: 120, y: 70 }]);
  });
});
