import { afterEach, describe, expect, it, vi } from "vitest";
import { DuckDBBigIntVector, DuckDBDoubleVector, DuckDBInstance, DuckDBListVector, DuckDBStructVector } from "@duckdb/node-api";
import { readBudgetedRows } from "./budget-reader";
import { ResultBudget, jsonBytes } from "./result-budget";
import { safeEngineMessage } from "./engine-message";

afterEach(() => vi.restoreAllMocks());

it("keeps generated budget identifiers inside the diagnostic sanitizer's namespace", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const stream = vi.spyOn(conn, "stream");
    expect(await readBudgetedRows(conn, "SELECT [1] AS v", new ResultBudget())).toEqual([{ v: [1] }]);
    const names = new Set(stream.mock.calls[0][0].match(/__\w+/g));
    expect(names.size).toBeGreaterThanOrEqual(2);
    for (const name of names) {
      expect(safeEngineMessage(`Binder Error: invalid reference to "${name}"`)).toBe("The query could not be completed.");
    }
  } finally { conn.disconnectSync(); db.closeSync(); }
});

it.each([
  ["SELECT range(2200000) AS v", false],
  [`SELECT '{"type":"MultiPolygon","coordinates":[[[[0.5,0.5],[1.5,0.5],[0.5,1.5],[0.5,0.5]]]]}' AS v`, true],
  ["SELECT {'v': [1, 2, 3]}::VARIANT AS v", false],
] as const)("refuses without copying native list storage: %s", async (sql, geometry) => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const copies = [DuckDBBigIntVector, DuckDBDoubleVector, DuckDBListVector, DuckDBStructVector]
      .map(vector => vi.spyOn(vector.prototype, "slice"));
    const budget = new ResultBudget();
    budget.take(33_554_432 - 10);
    await expect(readBudgetedRows(conn, sql, budget, new Set(geometry ? ["v"] : []), geometry))
      .rejects.toMatchObject({ code: "query_result_too_large" });
    for (const copy of copies) expect(copy).not.toHaveBeenCalled();
  } finally { conn.disconnectSync(); db.closeSync(); }
});

it("walks flat list offsets across rows, empty values and nulls", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const sql = "SELECT v FROM (VALUES ([[1], [], NULL]), (NULL), ([]), ([[2, 3], [4]])) t(v)";
    const expected = (await conn.runAndReadAll(sql)).getRowObjectsJson();
    expect(await readBudgetedRows(conn, sql, new ResultBudget())).toEqual(expected);
  } finally { conn.disconnectSync(); db.closeSync(); }
});

it.each([
  '{"type":"MultiPolygon","coordinates":[[[[0.5,0.5],[1.5,0.5],[0.5,1.5],[0.5,0.5]]]]}',
  '{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[0.5,1.5]},{"type":"LineString","coordinates":[[0.5,0.5],[1.5,1.5]]}]}',
])("decodes decimal geometry through every list depth without copying: %s", async geometry => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const copies = [DuckDBBigIntVector, DuckDBDoubleVector, DuckDBListVector, DuckDBStructVector]
      .map(vector => vi.spyOn(vector.prototype, "slice"));
    const numbers = vi.spyOn(DuckDBDoubleVector.prototype, "getItem");
    const rows = await readBudgetedRows(conn, `SELECT '${geometry}' AS v`, new ResultBudget(), new Set(["v"]), true);
    expect(rows).toEqual([{ v: JSON.parse(geometry) }]);
    expect(numbers).toHaveBeenCalled();
    for (const copy of copies) expect(copy).not.toHaveBeenCalled();
  } finally { conn.disconnectSync(); db.closeSync(); }
});

describe("native budget projection", () => {
  it("evaluates volatile values once, carrying their lengths beside those same values", async () => {
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    try {
      await conn.run("CREATE SEQUENCE sizes START 1");
      const budget = new ResultBudget(); budget.take(2);
      const rows = await readBudgetedRows(conn, "SELECT repeat('x', nextval('sizes')::INTEGER) AS v FROM range(3)", budget);
      expect(rows).toEqual([{ v: "x" }, { v: "xx" }, { v: "xxx" }]);
      expect((await conn.runAndReadAll("SELECT currval('sizes') AS n")).getRowObjects()[0].n).toBe(3n);
    } finally { conn.disconnectSync(); db.closeSync(); }
  });

  it("matches UTF-8 JSON for every control escape, multibyte text, surrogate pairs and nested envelopes", () => {
    const values = [null, true, 0, -0, 1e25, '"\\/é😀\ud800\udc00\ud800', Array.from({ length: 32 }, (_, c) => String.fromCharCode(c)).join(""), { columns: [{ name: '"é', type: "VARCHAR" }], preview: [{ '\\': [null, true, 'é😀\n'] }], runtimeMs: 101 }];
    for (const value of values) expect(jsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
  });
});
