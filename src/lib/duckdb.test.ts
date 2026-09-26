import { describe, it, expect } from "vitest";
import { withConnection } from "./duckdb";

describe("duckdb", () => {
  it("executes SQL with the spatial extension loaded", async () => {
    const rows = await withConnection(async (conn) => {
      const reader = await conn.runAndReadAll(
        "SELECT ST_AsText(ST_Point(1, 2)) AS wkt",
      );
      return reader.getRowObjects();
    });
    expect(rows).toEqual([{ wkt: "POINT (1 2)" }]);
  });

  it("isolates session state between connections", async () => {
    await withConnection(async (conn) => {
      await conn.run("CREATE TEMP TABLE t AS SELECT 1 AS x");
    });
    await withConnection(async (conn) => {
      const reader = await conn.runAndReadAll(
        "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 't'",
      );
      const n = reader.getRowObjects()[0].n;
      expect(Number(n)).toBe(0);
    });
  });
});
