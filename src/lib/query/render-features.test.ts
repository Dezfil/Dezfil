import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBResult, DuckDBVarCharVector, type DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { quoteIdent } from "./budget-projection";
import { buildInlineAnswer, type InlineFeature, type InlineRows } from "./render-features";
import { renderBytesExceeded } from "./render-budget";

let dir: string;
let conn: DuckDBConnection;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  conn = await connectQueryInstance();
});

afterEach(async () => {
  vi.restoreAllMocks();
  conn.disconnectSync();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** The answer shape a layer render composes, envelope fields included. */
const compose = (features: InlineFeature[], count: number) => ({
  layerId: "layer-é\"1",
  ok: true,
  mode: "inline" as const,
  geojson: { type: "FeatureCollection", features },
  featureCount: count,
  geometryType: "MIXED",
  liveFiltered: true,
  publishedFields: ["a", "\u0001"],
});

/** How layers were built before the budget: the engine's to_json text for
 * the properties and the GeoJSON text for the geometry, parsed whole. */
async function previous(rows: InlineRows) {
  const g = rows.geometry;
  const props = rows.properties.length
    ? `to_json({${rows.properties.map(n => `'${n.replace(/'/g, "''")}': ${quoteIdent(n)}`).join(", ")}})`
    : `'{}'`;
  const read = await conn.runAndReadAll(`SELECT ST_AsGeoJSON(${g}) AS geometry, ${props} AS props,
      CASE WHEN ST_GeometryType(${g}) = 'POINT' THEN NULL ELSE ST_AsGeoJSON(ST_PointOnSurface(${g})) END AS anchor
    FROM ${rows.from} WHERE ${g} IS NOT NULL`);
  return read.getRowObjects().map(r => {
    const properties = JSON.parse(String(r.props)) as Record<string, unknown>;
    if (r.anchor != null) properties.__anchor = (JSON.parse(String(r.anchor)) as { coordinates: unknown }).coordinates;
    return { type: "Feature" as const, geometry: JSON.parse(String(r.geometry)) as unknown, properties };
  });
}

async function columns(from: string): Promise<string[]> {
  const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`);
  return (described.getRowObjects() as { column_name: string; column_type: string }[])
    .filter(c => !c.column_type.startsWith("GEOMETRY")).map(c => c.column_name);
}

/** Admits the answer at exactly its serialized length and refuses it one
 * byte under, returning the admitted answer. */
async function exactly(rows: InlineRows) {
  const expected = compose(await previous(rows), (await previous(rows)).length);
  const bytes = Buffer.byteLength(JSON.stringify(expected), "utf8");
  const answer = await buildInlineAnswer(conn, rows, compose, bytes);
  // The serialized answer is what every reader receives, member order
  // included. (A negative zero inside decomposed coordinates reads as zero;
  // both serialize as 0.)
  expect(JSON.stringify(answer)).toBe(JSON.stringify(expected));
  await expect(buildInlineAnswer(conn, rows, compose, bytes - 1)).rejects.toMatchObject({ code: "render_bytes_exceeded", status: 422 });
  return answer;
}

const VALUES = `(SELECT ST_GeomFromText(wkt) AS geometry, * EXCLUDE (wkt) FROM (VALUES
  ('POINT (1 2)', 'plain', 7, 9007199254740993::BIGINT, 170141183460469231731687303715884105727::HUGEINT, 1e20::DOUBLE,
    1.2e-5::FLOAT, 123.4500::DECIMAL(10,4), DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05.123',
    TIMESTAMPTZ '2024-01-02 03:04:05+00', INTERVAL '1 year 2 days 03:04:05', '00000000-0000-0000-0000-000000000001'::UUID,
    '\\x01\\xFF'::BLOB, true, 'sad'::ENUM('ok', 'sad'), [1, NULL, 3], {'n': [{'k': 'v"'}], 'm': MAP {'x': [1.5, -0.0]}},
    MAP {'a': 1, 'é"': 2}, MAP {['a, b']: 1, ['a', 'b']: 2}, union_value(s := 'u')::UNION(k INTEGER, s VARCHAR),
    '{"a":"x\\u0001","a":[1,"two",{"w":3}],"a":{"z":[1.0,1E400,123456789012345678901234567890,-0]},"b":"é\\/","c":null,"d":[true,false]}'::JSON,
    ['{"q":1,"q":2}'::JSON], row(1, 'two'), 'kept', 'own'),
  ('POLYGON ((0 0, 3 0, 3 3, 0 3, 0 0))', 'tab\\t "quote" \\ é😀 ' || chr(1) || chr(8) || chr(127) || chr(8232), -1,
    NULL, NULL, -0.0::DOUBLE, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 'ok', [], NULL,
    MAP {}, NULL, union_value(k := NULL::INTEGER)::UNION(k INTEGER, s VARCHAR), '[]'::JSON, [], NULL, 'replaced', NULL),
  ('LINESTRING (0.1 0.2, 1e-7 3.3333333333333335)', NULL, 0, NULL, NULL, 0.1::DOUBLE, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '"just text"'::JSON, NULL, NULL, NULL, NULL)
) AS v(wkt, s, i, b, h, d, f, dec, dt, ts, tz, iv, u, bl, bo, en, l, st, m, mb, un, j, jl, tu, "__anchor", "__proto__")) AS q`;

describe("inline answers built under Bytes drawn per layer", () => {
  it("builds what layers drew before, and counts it to the byte", async () => {
    const rows = { from: VALUES, geometry: quoteIdent("geometry"), properties: await columns(VALUES) };
    const answer = await exactly(rows);
    // The fixture reaches every reader: escapes, nested values, nested map
    // keys, repeated names in a document, the anchor and a prototype name.
    const [point, polygon] = answer.geojson.features;
    expect(point.properties.__anchor).toBe("kept");
    expect(polygon.properties.__anchor).toEqual([expect.any(Number), expect.any(Number)]);
    expect(Object.keys(polygon.properties).at(-2)).toBe("__anchor");
    expect(Object.hasOwn(point.properties, "__proto__")).toBe(true);
    expect(point.properties.mb).toEqual({ "['a, b']": 1, "[a, b]": 2 });
    expect(point.properties.j).toEqual({ a: { z: [1, Infinity, 123456789012345678901234567890, 0] }, b: "é/", c: null, d: [true, false] });
  });

  it("counts JSON documents inside lists, maps, arrays, tuples and unions exactly", async () => {
    // Repeated names, escapes, a number the parser respells, a JSON text,
    // empty and missing documents, at every depth a document can sit.
    const nested = `(SELECT ST_GeomFromText(wkt) AS geometry, * EXCLUDE (wkt) FROM (VALUES
      ('POINT (1 2)',
        ['{"a":"x\\u0001","a":[1,"two"],"b":"é\\/😀\\u00e9"}'::JSON, NULL, '[]'::JSON, '"just text"'::JSON, '{"q":1,"q":2}'::JSON],
        MAP {'k"é': '{"z":[1.0,-0,1E400],"z":{"w":null}}'::JSON, 'n': NULL::JSON},
        [{'j': '[true,false,null]'::JSON, 'n': 1}],
        [['{"deep":["\\u00e9"]}'::JSON], [], NULL],
        ['{"r":1}'::JSON, '[2]'::JSON]::JSON[2],
        [union_value(j := '{"u":"w"}'::JSON)::UNION(j JSON, n INTEGER)]),
      ('LINESTRING (0 0, 1 1)', [], MAP {}, [], [], NULL, []),
      ('POINT (3 4)', NULL, NULL, NULL, NULL, NULL, NULL)
    ) AS v(wkt, jl, jm, js, jn, ja, ju)) AS q`;
    const answer = await exactly({ from: nested, geometry: quoteIdent("geometry"), properties: await columns(nested) });
    const [first, second] = answer.geojson.features;
    expect(first.properties.jl).toEqual([{ a: [1, "two"], b: "é/😀é" }, null, [], "just text", { q: 2 }]);
    expect(first.properties.jm).toEqual({ 'k"é': { z: { w: null } }, n: null });
    expect(first.properties.jn).toEqual([[{ deep: ["é"] }], [], null]);
    expect(second.properties).toMatchObject({ jl: [], jm: {}, jn: [] });
  });

  it("counts large decimal geometry and an empty property set exactly", async () => {
    const ring = Array.from({ length: 4000 }, (_, i) => `${(Math.cos(i / 637) * 10.123456789).toFixed(9)} ${(Math.sin(i / 637) * 5.5).toFixed(9)}`);
    const from = `(SELECT ST_GeomFromText('POLYGON ((${[...ring, ring[0]].join(", ")}))') AS geometry) AS q`;
    const answer = await exactly({ from, geometry: quoteIdent("geometry"), properties: [] });
    expect(answer.featureCount).toBe(1);
  });

  it("reads every geometry spelling as its GeoJSON text parses", async () => {
    const shapes = ["POINT (-0.0 1)", "POINT EMPTY", "POINT Z (1 2 3)", "MULTIPOINT ((1 1), (2.5 2))", "LINESTRING (-0.0 0, 1 1)",
      "LINESTRING (1e-9 12345678901234567, 1e21 0.30000000000000004)", "POINT (1e21 1)", "POLYGON Z ((0 0 1, 3 0 1, 3 3 1, 0 0 1))",
      "GEOMETRYCOLLECTION (POINT (0.5 1.5), LINESTRING (0 0, 1.25 1))", "POLYGON EMPTY"];
    // One answer per shape, so an over-count and an under-count cannot
    // cancel out.
    for (const wkt of shapes) {
      const from = `(SELECT ST_GeomFromText('${wkt}') AS geometry, '${wkt}' AS wkt) AS q`;
      const answer = await exactly({ from, geometry: quoteIdent("geometry"), properties: ["wkt"] });
      expect(answer.featureCount).toBe(1);
    }
  });

  it("counts the feature count's own digits", async () => {
    const from = `(SELECT ST_Point(i, 0) AS geometry, i AS id FROM range(1234) t(i)) AS q`;
    const answer = await exactly({ from, geometry: quoteIdent("geometry"), properties: ["id"] });
    expect(answer.featureCount).toBe(1234);
  });

  it("has no ceiling for one value apart from the whole answer", async () => {
    const from = `(SELECT ST_Point(0, 0) AS geometry, repeat('x', 3 * 1024 * 1024) AS payload) AS q`;
    const answer = await buildInlineAnswer(conn, { from, geometry: quoteIdent("geometry"), properties: ["payload"] }, compose, 8 * 1024 * 1024);
    expect((answer.geojson.features[0].properties.payload as string).length).toBe(3 * 1024 * 1024);
  });

  it("refuses an envelope larger than the limit before reading a row", async () => {
    const fetches = vi.spyOn(DuckDBResult.prototype, "fetchChunk");
    const from = `(SELECT ST_Point(0, 0) AS geometry) AS q`;
    await expect(buildInlineAnswer(conn, { from, geometry: quoteIdent("geometry"), properties: [] }, compose, 64))
      .rejects.toMatchObject({ code: "render_bytes_exceeded" });
    expect(fetches).not.toHaveBeenCalled();
  });

  it("says what was refused and how to raise the limit", () => {
    expect(renderBytesExceeded(134_217_728).message).toBe("This layer's answer is larger than 134,217,728 bytes, the limit for one layer drawn in the map. Filter or aggregate it, or raise DEZFIL_RENDER_CAP_BYTES and restart.");
  });
});

/**
 * Early refusal, observed at the boundary where native data becomes
 * JavaScript: the rows fetched from the engine (a completed feature needs
 * its row), the text converted from native storage (the longest one and
 * all of it), the longest text parsed, and whether the complete answer was
 * ever serialized. A refusal counts as early only when all of them stay
 * bounded; resource figures alone could not tell a late refusal from an
 * early one.
 */
interface Observed { refused: boolean; rows: number; longestText: number; converted: number; longestParse: number; serialized: number }

async function observe(run: () => Promise<unknown>): Promise<Observed> {
  const seen: Observed = { refused: false, rows: 0, longestText: 0, converted: 0, longestParse: 0, serialized: 0 };
  const fetch = DuckDBResult.prototype.fetchChunk;
  vi.spyOn(DuckDBResult.prototype, "fetchChunk").mockImplementation(async function (this: DuckDBResult) {
    const chunk = await fetch.call(this);
    seen.rows += chunk?.rowCount ?? 0;
    return chunk;
  });
  const item = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index: number) {
    const text = item.call(this, index);
    if (text !== null) {
      seen.longestText = Math.max(seen.longestText, Buffer.byteLength(text));
      seen.converted += Buffer.byteLength(text);
    }
    return text;
  });
  const parse = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementation(function (text: string, ...rest: unknown[]) {
    if (typeof text === "string") seen.longestParse = Math.max(seen.longestParse, text.length);
    return (parse as (...args: unknown[]) => unknown)(text, ...rest);
  });
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation(function (value: unknown, ...rest: unknown[]) {
    if (value && typeof value === "object" && "geojson" in value) seen.serialized++;
    return (stringify as (...args: unknown[]) => string)(value, ...rest);
  });
  try { await run(); } catch (error) {
    if ((error as { code?: string }).code !== "render_bytes_exceeded") throw error;
    seen.refused = true;
  } finally { vi.restoreAllMocks(); }
  return seen;
}

const LIMIT = 1_048_576;
/** Refused within the chunk that crossed the limit, no text over the limit
 * converted or parsed, no more text converted in all than the answer could
 * hold (an eighth over, for the names of the nodes a document is walked
 * by), and no complete answer serialized. */
const refusedEarly = (o: Observed, limit = LIMIT) => o.refused && o.rows <= 2048 && o.longestText <= limit && o.longestParse <= limit
  && o.converted <= limit + limit / 8 && o.serialized === 0;

/** The deliberately late control: the same rows, properties and envelope,
 * built without incremental checks, then refused by its serialized length. */
async function lateRefusal(rows: InlineRows, limit = LIMIT) {
  const answer = await buildInlineAnswer(conn, rows, compose, Number.MAX_SAFE_INTEGER);
  if (Buffer.byteLength(JSON.stringify(answer), "utf8") > limit) throw renderBytesExceeded(limit);
  return answer;
}

describe("an oversized answer is refused before it is built", () => {
  const manySmall: InlineRows = {
    from: `(SELECT ST_Point(0, 0) AS geometry, i AS id, repeat('x', 2048) AS payload FROM range(20000) t(i)) AS q`,
    geometry: quoteIdent("geometry"),
    properties: ["id", "payload"],
  };
  const oneValue: InlineRows = {
    from: `(SELECT ST_Point(0, 0) AS geometry, 0 AS id, repeat('x', 16 * 1024 * 1024) AS payload) AS q`,
    geometry: quoteIdent("geometry"),
    properties: ["id", "payload"],
  };

  it.each([["many small features", manySmall], ["one oversized value", oneValue]] as const)("%s: refused early, while the late control is not", async (_, rows) => {
    const early = await observe(() => buildInlineAnswer(conn, rows, compose, LIMIT));
    const late = await observe(() => lateRefusal(rows));
    expect(early).toMatchObject({ refused: true, serialized: 0 });
    expect(refusedEarly(early)).toBe(true);
    // The control returns the same refusal, and fails the proof.
    expect(late.refused).toBe(true);
    expect(refusedEarly(late)).toBe(false);
    expect(late.serialized).toBe(1);
    if (rows === manySmall) expect(late.rows).toBe(20000);
    else expect(late.longestText).toBe(16 * 1024 * 1024);
  });

  it("admits a small answer through both", async () => {
    const small = { ...manySmall, from: `(SELECT ST_Point(0, 0) AS geometry, i AS id, repeat('x', 64) AS payload FROM range(100) t(i)) AS q` };
    const early = await observe(() => buildInlineAnswer(conn, small, compose, LIMIT));
    const late = await observe(() => lateRefusal(small));
    expect(early.refused || late.refused).toBe(false);
  });
});

describe("a JSON document inside a list or a map is refused before it is converted", () => {
  /** One feature whose one property holds a document of about 4 MiB, four
   * times the limit, in 4,096 members or items of 1 KiB each. */
  const documentIn = (holder: (doc: string) => string, document: string): InlineRows => ({
    from: `(SELECT ST_Point(0, 0) AS geometry, ${holder("doc")} AS docs FROM (SELECT ${document} AS doc FROM range(4096) t(i))) AS q`,
    geometry: quoteIdent("geometry"),
    properties: ["docs"],
  });
  const object = "json_group_object('member ' || i, repeat('x', 1024))";
  const array = "json_group_array(repeat('x', 1024))";
  const inList = (doc: string) => `[${doc}]`;
  const inMap = (doc: string) => `MAP {'doc': ${doc}}`;
  const cases = [
    ["an object in a list", documentIn(inList, object)],
    ["an array in a list", documentIn(inList, array)],
    ["an object in a map", documentIn(inMap, object)],
    ["an array in a map", documentIn(inMap, array)],
  ] as const;

  it.each(cases)("%s: refused early, while the late control is not", async (_, rows) => {
    const early = await observe(() => buildInlineAnswer(conn, rows, compose, LIMIT));
    const late = await observe(() => lateRefusal(rows));
    expect(early).toMatchObject({ refused: true, serialized: 0 });
    expect(refusedEarly(early)).toBe(true);
    expect(early.longestText).toBeLessThan(2048);
    // The control returns the same refusal, and fails the proof: it
    // converted the whole document before measuring it.
    expect(late.refused).toBe(true);
    expect(refusedEarly(late)).toBe(false);
    expect(late.converted).toBeGreaterThan(3 * LIMIT);
  });

  it.each(cases)("%s: admitted at exactly its size", async (_, rows) => {
    const answer = await exactly(rows);
    expect(answer.featureCount).toBe(1);
  });

  it("admits a document of the same size outside a list at exactly its size", async () => {
    const answer = await exactly(documentIn((doc) => doc, object));
    expect(Object.keys(answer.geojson.features[0].properties.docs as object)).toHaveLength(4096);
  });

  it("counts a repeated name's last value only, without converting the values it replaces", async () => {
    const rows: InlineRows = {
      from: `(SELECT ST_Point(0, 0) AS geometry, [('{"a":"' || repeat('x', 1048576) || '","b":{"c":1,"c":2},"a":1}')::JSON] AS docs) AS q`,
      geometry: quoteIdent("geometry"),
      properties: ["docs"],
    };
    const answer = await exactly(rows);
    expect(answer.geojson.features[0].properties.docs).toEqual([{ a: 1, b: { c: 2 } }]);
    const seen = await observe(() => buildInlineAnswer(conn, rows, compose, Buffer.byteLength(JSON.stringify(answer), "utf8")));
    expect(seen.refused).toBe(false);
    expect(seen.longestText).toBeLessThan(1024);
  });
});

describe("a document whose names repeat is charged name by name before they are converted", () => {
  const holders = [["at the top level", (doc: string) => doc], ["inside a list", (doc: string) => `[${doc}]`]] as const;
  const rowsOf = (document: string): InlineRows => ({
    from: `(SELECT ST_Point(0, 0) AS geometry, ${document} AS docs) AS q`,
    geometry: quoteIdent("geometry"),
    properties: ["docs"],
  });

  it.each(holders)("%s: a 1 MiB name before a repeated short name is refused unconverted under 64 KiB", async (_, holder) => {
    const limit = 65_536;
    const rows = rowsOf(holder(`('{"' || repeat('k', 1048576) || '":1,"x":1,"x":2}')::JSON`));
    const early = await observe(() => buildInlineAnswer(conn, rows, compose, limit));
    expect(early).toMatchObject({ refused: true, serialized: 0 });
    expect(refusedEarly(early, limit)).toBe(true);
    expect(early.longestText).toBeLessThan(1024);
    // The control converts the name whole before measuring the answer.
    const late = await observe(() => lateRefusal(rows, limit));
    expect(late.refused).toBe(true);
    expect(refusedEarly(late, limit)).toBe(false);
    expect(late.longestText).toBeGreaterThanOrEqual(1_048_576);
  });

  it.each(holders)("%s: 4,096 distinct 1 KiB names before a repeated name are refused once the names counted pass the limit", async (_, holder) => {
    const doc = `(SELECT ('{' || string_agg('"m' || lpad(i::VARCHAR, 4, '0') || repeat('k', 1019) || '":' || i, ',' ORDER BY i) || ',"x":1,"x":2}')::JSON FROM range(4096) t(i))`;
    const rows = rowsOf(holder(doc));
    const early = await observe(() => buildInlineAnswer(conn, rows, compose, LIMIT));
    expect(early).toMatchObject({ refused: true, serialized: 0 });
    expect(refusedEarly(early)).toBe(true);
    expect(early.longestText).toBeLessThan(2048);
    const late = await observe(() => lateRefusal(rows));
    expect(late.refused).toBe(true);
    expect(refusedEarly(late)).toBe(false);
    expect(late.converted).toBeGreaterThan(4 * LIMIT);
  });

  it.each(holders)("%s: admitted at exactly its size, refused one byte under, each name converted once", async (_, holder) => {
    // A long name once, same-length names that differ, repeated names with
    // the first place and the last value, an escaped name, and a nested
    // object whose names repeat.
    const rows = rowsOf(holder(`('{"' || repeat('k', 400000) || '":1,"ab":1,"cd":[1,2],"ab":{"z":1,"z":"two"},"é\\"":null,"x":1,"x":"last"}')::JSON`));
    const answer = await exactly(rows);
    const docs = answer.geojson.features[0].properties.docs;
    expect(Array.isArray(docs) ? docs[0] : docs).toMatchObject({ ab: { z: "two" }, cd: [1, 2], 'é"': null, x: "last" });
    const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
    const admitted = await observe(() => buildInlineAnswer(conn, rows, compose, bytes));
    expect(admitted.refused).toBe(false);
    expect(admitted.converted).toBeLessThanOrEqual(bytes + bytes / 8);
    const refused = await observe(() => buildInlineAnswer(conn, rows, compose, bytes - 1));
    expect(refusedEarly(refused, bytes - 1)).toBe(true);
  });
});
