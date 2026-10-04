import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection, DuckDBResult, DuckDBVarCharVector } from "@duckdb/node-api";
import { withConnection } from "@/lib/duckdb";
import { setupGeometryTest, cleanupGeometryTest } from "@/lib/test-support/geometry";
import { PgPreviewOwner } from "./preview-owner";

const fixture = vi.hoisted(() => ({ sql: "SELECT 1 AS v", columns: [{ name: "v", udt: "text" }], source: "" }));
vi.mock("./access", async importOriginal => ({
  ...await importOriginal<typeof import("./access")>(),
  readConnectionHealth: async () => ({ serverVersion: "fixture", postgisVersion: "fixture" }),
  fetchColumns: async () => fixture.columns,
  withPg: async (_target: unknown, work: Parameters<typeof import("./access").withPg>[1], options: { signal?: AbortSignal }) => withConnection(async conn => {
    const owner = new PgPreviewOwner(options.signal);
    try { return await work(owner.bind(conn), select => { fixture.source = select; return `(${fixture.sql} LIMIT 5)`; }); }
    finally { owner.drainComplete(); }
  }),
}));
import { buildPostgisPreview, previewReadError } from "./preview";
import { QueryResultTooLarge, EvaluationCancelled } from "@/lib/api/errors";
const target = { host: "fixture", port: 5432, database: "fixture", username: "fixture", password: "", ssl: false };
const preview = (signal?: AbortSignal) => buildPostgisPreview(target, { schema: "public", table: "sample" }, undefined, signal);
const refused = async (value: Promise<unknown>) => expect(await value.then(() => null, e => e)).toMatchObject({ code: "query_result_too_large", status: 422 });
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); fixture.columns = [{ name: "v", udt: "text" }]; });
afterEach(async () => { vi.restoreAllMocks(); await cleanupGeometryTest(dir); });
it("preserves the typed refusal through the broad source catch", () => {
  const error = new QueryResultTooLarge();
  expect(previewReadError(error)).toBe(error);
});
it.each([-1, 0, 1])("counts quotes at the source text cell boundary (%s)", async delta => {
  fixture.sql = `SELECT repeat('x', ${2097150 + delta}) AS v`;
  if (delta > 0) await refused(preview());
  else expect(Buffer.byteLength(JSON.stringify((await preview()).rows[0].v))).toBe(2097152 + delta);
});
it("refuses nested and escaped cells without decoding excess or later values", async () => {
  const decoded: number[] = [];
  const original = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, i) {
    const value = original.call(this, i); if (value && value.length >= 100000) decoded.push(value.length); return value;
  });
  for (const value of ["[repeat('x', 2097151)]", "repeat(chr(10), 1048576)"]) {
    fixture.sql = `SELECT ${value} AS v, repeat('z', 100000) AS later`;
    await refused(preview());
  }
  expect(decoded).toEqual([]);
});
it.each(["geometry", "geography"])("exempts source %s WKT, retaining the five-row limit and source projection", async udt => {
  fixture.columns = [{ name: "v", udt }];
  fixture.sql = "SELECT 'LINESTRING (' || repeat('0 0,', 550000) || '1 1)' AS v FROM range(6)";
  const answer = await preview();
  expect(answer.rows).toHaveLength(5);
  expect(Buffer.byteLength(JSON.stringify(answer.rows[0].v))).toBeGreaterThan(2097152);
  expect(answer.columns).toEqual([{ name: "v", type: udt, spatialKind: udt }]);
  expect(fixture.source).toBe('SELECT ST_AsText("v") AS "v" FROM "public"."sample" LIMIT 5');
  fixture.columns = [{ name: "v", udt: "text" }];
  await refused(preview());
});
it("fits the columns and rows envelope independently, excluding internal health", async () => {
  fixture.columns = Array.from({ length: 4 }, (_, i) => ({ name: `v${i}`, udt: "text" }));
  const sql = (tail: number) => `SELECT ${fixture.columns.map((c, i) => `repeat('x', ${i === 3 ? `CASE range WHEN 4 THEN ${tail} ELSE 1700000 END` : 1700000}) AS ${c.name}`).join(",")} FROM range(5)`;
  fixture.sql = sql(1);
  const { columns, rows } = await preview();
  const overhead = Buffer.byteLength(JSON.stringify({ columns, rows })) - 19 * 1700000 - 1;
  for (const delta of [-1, 0, 1]) {
    fixture.sql = sql(33554432 - overhead - 19 * 1700000 + delta);
    if (delta > 0) await refused(preview());
    else { const { columns, rows } = await preview(); expect(Buffer.byteLength(JSON.stringify({ columns, rows }))).toBe(33554432 + delta); }
  }
});
it("stops before the crossing geometry and next chunk and releases native ownership", async () => {
  fixture.columns = [{ name: "v", udt: "geometry" }];
  fixture.sql = "SELECT repeat('x', 10000000) AS v FROM range(5)";
  const decoded: number[] = [];
  const original = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, i) {
    const value = original.call(this, i); if (value && value.length >= 100000) decoded.push(value.length); return value;
  });
  const fetches = vi.spyOn(DuckDBResult.prototype, "fetchChunk");
  const release = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
  await refused(preview());
  expect(decoded).toEqual([10000000, 10000000, 10000000]);
  expect(fetches.mock.contexts.filter(r => (r as DuckDBResult).columnNames().includes("v"))).toHaveLength(1);
  expect(release).toHaveBeenCalledOnce();
});
it("discards a chunk after caller departure without decoding it", async () => {
  const controller = new AbortController();
  fixture.sql = "SELECT repeat('x', 1000000) AS v";
  const original = DuckDBResult.prototype.fetchChunk;
  vi.spyOn(DuckDBResult.prototype, "fetchChunk").mockImplementation(async function (this: DuckDBResult) {
    const chunk = await original.call(this); controller.abort(); return chunk;
  });
  expect(await preview(controller.signal).then(() => null, e => e)).toBeInstanceOf(EvaluationCancelled);
});
