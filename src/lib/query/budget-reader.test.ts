import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { readBudgetedRows } from "./budget-reader";
import { ResultBudget, jsonBytes } from "./result-budget";

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
