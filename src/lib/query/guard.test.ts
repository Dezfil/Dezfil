import { describe, it, expect } from "vitest";
import { withConnection } from "@/lib/duckdb";
import { assertReadOnlySelect } from "./guard";

function check(sql: string) {
  return withConnection((conn) => assertReadOnlySelect(conn, sql));
}

describe("assertReadOnlySelect", () => {
  it("accepts plain, CTE, and FROM-first SELECTs", async () => {
    await expect(check("SELECT 1")).resolves.toBeUndefined();
    await expect(
      check("WITH x AS (SELECT 1 AS a) SELECT * FROM x"),
    ).resolves.toBeUndefined();
    await expect(check("FROM range(3)")).resolves.toBeUndefined();
  });

  it("rejects non-SELECT statements with the documented code", async () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "CREATE TABLE t (a INT)",
      "DROP TABLE t",
      "SET threads = 1",
      "ATTACH 'other.db'",
      "COPY t TO 'out.csv'",
      "INSTALL spatial",
      "LOAD spatial",
      "PRAGMA database_list",
      "/* sneaky */ INSERT INTO t VALUES (1)",
    ]) {
      await expect(check(sql), sql).rejects.toMatchObject({
        code: "sql_rejected",
      });
    }
  });

  it("rejects multiple statements", async () => {
    await expect(check("SELECT 1; SELECT 2")).rejects.toMatchObject({
      code: "sql_rejected",
    });
  });

  it("surfaces syntax errors as sql_error with the engine message", async () => {
    await expect(check("SELEC 1")).rejects.toMatchObject({
      code: "sql_error",
      message: expect.stringContaining("SELEC"),
    });
  });
});
