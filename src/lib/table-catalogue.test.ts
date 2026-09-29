import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { withConnection } from "./duckdb";
import { insertTable } from "./metadata/tables";
import { closeMetadataDb } from "./metadata/db";
import { GET } from "@/app/api/catalogue/tables/route";
import { buildTools } from "./tools/tools";
import { executeTool } from "./tools/execute";
import { parseCatalogueQuery, readTableCatalogue } from "./table-catalogue";

let dir: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-catalogue-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeMetadataDb();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function seed(count = 1, columns = 3, namePadding = 0) {
  await withConnection(async (conn) => {
    const fields = Array.from({ length: columns }, (_, i) => `${i} AS "column_${i}${"x".repeat(namePadding)}"`).join(", ");
    await conn.run(`COPY (SELECT ${fields} FROM range(2)) TO '${dir.replace(/'/g, "''")}/private.parquet' (FORMAT PARQUET)`);
  });
  for (let i = 0; i < count; i++) insertTable(testAccountScope(), {
    id: `table-${i}`, name: `table_${String(i).padStart(2, "0")}`, file: "private.parquet",
    sourceFilename: "secret-source.csv", format: "geoparquet", geometryColumn: null, geometryType: null,
    crsAssumed: false, headerSuspect: false, rowCount: 987, createdAt: "2026-09-15T00:00:00Z",
    source: "url", sourceParams: { url: "https://user:SECRET@example.com/file", content_base64: "PRIVATE_BYTES" }, importedAt: null,
  });
}
function request(query = "") { return new Request(`http://localhost:3201/api/catalogue/tables${query}`); }

describe("schema-only catalogue", () => {
  it("returns recorded counts and schema, never row/config/path content or row preview queries", async () => {
    await seed();
    const read = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll");
    const run = vi.spyOn(DuckDBConnection.prototype, "run");
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ total: 1, nextAfter: null, tables: [{
      id: "table-0", name: "table_00", rowCount: 987, geometryColumn: null, geometryType: null, crsAssumed: false,
      columns: [0, 1, 2].map((i) => ({ name: `column_${i}`, type: "INTEGER" })), columnCount: 3, nextColumnOffset: null,
    }] });
    const queries = read.mock.calls.map(([sql]) => sql);
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => sql.includes("pragma_table_info('catalogue_schema')"))).toBe(true);
    const executed = run.mock.calls.map(([sql]) => sql);
    expect(executed).toEqual([
      "LOAD spatial",
      `CREATE OR REPLACE TEMP VIEW catalogue_schema AS SELECT * FROM read_parquet('${dir.replace(/'/g, "''")}/private.parquet')`,
      "SELECT COUNT(*) AS count FROM pragma_table_info('catalogue_schema')",
      "SELECT name, type FROM pragma_table_info('catalogue_schema') ORDER BY cid LIMIT 64 OFFSET 0",
    ]);
    for (const secret of ["SECRET", "PRIVATE_BYTES", "private.parquet", "sourceParams", "preview", "secret-source.csv"]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });
  it("pages 32 tables and 64 columns, inspecting only admitted schemas", async () => {
    await seed(33, 65);
    const read = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll");
    const first = await (await GET(request())).json();
    expect(first.total).toBe(33);
    expect(first.tables).toHaveLength(32);
    expect(first.nextAfter).toBe("table_31");
    expect(first.tables[0].columns).toHaveLength(64);
    expect(first.tables[0].columnCount).toBe(65);
    expect(first.tables[0].nextColumnOffset).toBe(64);
    expect(read).toHaveBeenCalledTimes(64);
    const second = await (await GET(request("?after=table_31"))).json();
    expect(second.tables.map((t: { name: string }) => t.name)).toEqual(["table_32"]);
    expect(second.nextAfter).toBeNull();
    const remaining = await (await GET(request("?names=table_00&columnOffset=64"))).json();
    expect(remaining.tables[0].columns).toEqual([{ name: "column_64", type: "INTEGER" }]);
    expect(remaining.tables[0].nextColumnOffset).toBeNull();
  });
  it("distinguishes empty catalogue, missing named table and failed artifact read", async () => {
    expect(await (await GET(request())).json()).toEqual({ tables: [], total: 0, nextAfter: null });
    expect((await GET(request("?names=missing"))).status).toBe(404);
    await seed();
    await rm(path.join(dir, "private.parquet"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal");
  });
  it("validates each page bound before schema work", async () => {
    const read = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll");
    for (const query of ["?limit=33", "?limit=0", "?columns=65", "?columns=-1", "?columnOffset=-1", "?columnOffset=1.5", "?names=", "?names=a,a", "?names=" + Array.from({ length: 33 }, (_, i) => i).join(","), "?extra=x", "?limit=1&limit=2"]) {
      expect((await GET(request(query))).status, query).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses a response above 96 KiB and permits a smaller column page", async () => {
    await seed(1, 64, 2000);
    const response = await GET(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("catalogue_too_large");
    const smaller = await GET(request("?columns=1"));
    expect(smaller.status).toBe(200);
    const body = await smaller.json();
    expect(body.tables[0].columns[0].name).toHaveLength(2008);
    expect(body.tables[0].columnCount).toBe(64);
    expect(body.tables[0].nextColumnOffset).toBe(1);
  });
  it("has a generated read-only tool whose pagination arguments reach the real route", async () => {
    await seed(2, 2);
    const tool = buildTools().find((entry) => entry.name === "read_table_catalogue")!;
    expect(tool.effects).toEqual({ readOnly: true, writes: [] });
    const response = await executeTool(tool, { limit: 1, columns: 1 }, "http://localhost:3201", async (url) => GET(new Request(String(url))));
    expect(response.ok).toBe(true);
    expect(response.body).toMatchObject({ total: 2, nextAfter: "table_00", tables: [{ name: "table_00", columnCount: 2, columns: [{ name: "column_0" }], nextColumnOffset: 1 }] });
  });
  it("refuses an already cancelled read before acquiring the engine", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readTableCatalogue(parseCatalogueQuery(new URL(request().url)), controller.signal)).rejects.toThrow("abandoned");
  });
});
