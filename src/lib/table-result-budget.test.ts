import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DuckDBConnection, DuckDBResult, DuckDBVarCharVector } from "@duckdb/node-api";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { geometryOfBytes, countryGeometryRows } from "@/lib/test-support/budget-geometry";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertTable, listTables } from "@/lib/metadata/tables";
import { createProject, fileTable } from "@/lib/metadata/projects";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { retirementsSettled } from "@/lib/ingest/retire";
import { inspectTable, tableFeatures, listTablesWithSize } from "./table-service";
import { createMap } from "./map-service";
import { createLayer, renderLayer } from "./layer-service";
import { exportQueryResult, exportLayerResult } from "./export/layer-export";
import { GET, DELETE } from "@/app/api/tables/[name]/route";
import { GET as download } from "@/app/api/tables/[name]/export/route";

const sentence = "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.";
const refusal = { code: "query_result_too_large", status: 422, message: sentence, extra: {} };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  vi.restoreAllMocks(); await retirementsSettled(); closeMetadataDb(); resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function seed(name: string, sql: string, rowCount: number, geometryColumn: string | null = null) {
  const file = `tables/${name}.parquet`;
  const target = path.join(process.env.DEZFIL_DATA_DIR!, file);
  await mkdir(path.dirname(target), { recursive: true });
  await withConnection(conn => conn.run(`COPY (${sql}) TO '${target.replaceAll("'", "''")}' (FORMAT PARQUET)`));
  insertTable(testAccountScope(), { id: name, name, file, sourceFilename: "", format: "geoparquet", geometryColumn,
    geometryType: geometryColumn ? "LINESTRING" : null, crsAssumed: false, headerSuspect: false,
    rowCount, createdAt: "2026-01-01T00:00:00.000Z", source: "upload", sourceParams: null, importedAt: null });
  return target;
}
const inspect = (name: string) => inspectTable(testAccountScope(), name);
const params = (name: string) => ({ params: Promise.resolve({ name }) });
const request = (name: string, suffix = "", method = "GET") => testAccountRequest(new Request(`http://test/api/tables/${name}${suffix}`, { method }));
const outcome = (answer: Promise<unknown>) => answer.then(() => null, error => error);

async function measure(bytes: AsyncIterable<Uint8Array>) {
  let size = 0, lines = 0, xs = 0;
  for await (const chunk of bytes) {
    size += chunk.byteLength;
    for (const byte of chunk) { if (byte === 10) lines++; if (byte === 120) xs++; }
  }
  return { size, lines, xs };
}

describe("dataset inspection result budget", () => {
  it("refuses the full metadata envelope at plus-one and admits minus-one and equality", async () => {
    await seed("envelope", "SELECT repeat('x', 1000000) AS value FROM range(33)", 33);
    await seed("source", "SELECT 1 AS id", 1);
    const project = createProject(testAccountScope(), { name: "Coast é" });
    fileTable("envelope", project.id);
    metadataDb().prepare("UPDATE data_tables SET source = 'operation', source_params = ? WHERE id = 'envelope'").run(JSON.stringify({ inputs: [{ id: "source", name: "source" }] }));
    const fitting = await inspect("envelope");
    expect(fitting.projectIds).toEqual([project.id]);
    expect(fitting.inputs).toEqual([{ id: "source", name: "source", currentName: "source", missing: false }]);
    const base = Buffer.byteLength(JSON.stringify(fitting));
    expect(base).toBeLessThan(33_554_432);
    expect(Buffer.byteLength(JSON.stringify(fitting.preview))).toBeLessThan(33_554_432);
    for (const delta of [-1, 0, 1]) {
      metadataDb().prepare("UPDATE data_tables SET source_filename = ? WHERE id = 'envelope'").run("m".repeat(33_554_432 - base + delta));
      const response = await GET(request("envelope"), params("envelope"));
      const body = await response.text();
      if (delta > 0) {
        expect(response.status).toBe(422);
        expect(Buffer.byteLength(body)).toBeLessThan(1024);
        expect(JSON.parse(body)).toEqual({ error: { code: "query_result_too_large", message: sentence } });
      } else {
        expect(response.status).toBe(200);
        expect(Buffer.byteLength(body)).toBe(33_554_432 + delta);
      }
    }
  });

  it.each([-1, 0, 1])("applies the non-geometry cell ceiling including quotes (%s)", async delta => {
    await seed("cell", `SELECT repeat('x', ${2097150 + delta}) AS geometry`, 1);
    if (delta > 0) expect(await outcome(inspect("cell"))).toMatchObject(refusal);
    else expect(Buffer.byteLength(JSON.stringify((await inspect("cell")).preview[0].geometry))).toBe(2097152 + delta);
  });

  it("checks native lengths before decoding an oversized value and releases inspection", async () => {
    await seed("late", "SELECT repeat('x', 2097151) AS value, repeat('y', 100000) AS later", 1);
    const decoded: number[] = [];
    const original = DuckDBVarCharVector.prototype.getItem;
    vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
      const value = original.call(this, index);
      if (value && value.length >= 100000) decoded.push(value.length);
      return value;
    });
    const released = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
    expect(await outcome(inspect("late"))).toMatchObject(refusal);
    expect(decoded).toEqual([]);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("stops at the crossing result value without fetching again and releases inspection", async () => {
    await seed("forty", "SELECT repeat('x', 1000000) AS payload FROM range(40)", 40);
    const decoded: number[] = [];
    const original = DuckDBVarCharVector.prototype.getItem;
    vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
      const value = original.call(this, index);
      if (value && value.length >= 100000) decoded.push(Buffer.byteLength(JSON.stringify(value)));
      return value;
    });
    const fetches = vi.spyOn(DuckDBResult.prototype, "fetchChunk");
    const released = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
    expect(await outcome(inspect("forty"))).toMatchObject(refusal);
    expect(decoded).toHaveLength(33);
    expect(decoded.reduce((a, b) => a + b, 0)).toBeLessThan(33_554_432);
    expect(fetches.mock.contexts.filter(result => (result as DuckDBResult).columnNames().includes("payload"))).toHaveLength(1);
    expect(released).toHaveBeenCalledTimes(1);
    await seed("narrow", "SELECT 42 AS answer", 1);
    expect((await inspect("narrow")).preview).toEqual([{ answer: 42 }]);
  });

  it.each(["repeat('é', 1048576)", "repeat(chr(10), 1048576)", "[repeat('x', 1100000), repeat('y', 1100000)]", "{'value': repeat('x', 2097141)}"])("counts multibyte, escaped and nested cell bytes: %s", async expression => {
    await seed("represented", `SELECT ${expression} AS value`, 1);
    expect(await outcome(inspect("represented"))).toMatchObject(refusal);
  });

  it("admits native WKT coastline controls in the fifty-row window", async () => {
    for (const bytes of [10_151_576, 6_138_709]) {
      await seed(`coast_${bytes}`, `SELECT ${geometryOfBytes(bytes)} AS coast`, 1, "coast");
      const answer = await inspect(`coast_${bytes}`);
      expect(answer.preview).toHaveLength(1);
      expect(String(answer.preview[0].coast)).toMatch(/^LINESTRING/);
      expect(Buffer.byteLength(JSON.stringify(answer.preview[0].coast))).toBeGreaterThan(2_097_152);
      expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(33_554_432);
    }
    await seed("countries", countryGeometryRows(), 258, "coast");
    const countries = await inspect("countries");
    expect(countries.rowCount).toBe(258); expect(countries.preview).toHaveLength(50);
    expect(String(countries.preview[0].coast)).toMatch(/^LINESTRING/);
  });

  it("refuses complete WKT geometry overflow while keeping the geometry cell exemption", async () => {
    await seed("geometry_overflow", `SELECT ${geometryOfBytes(10_151_576)} AS coast FROM range(4)`, 4, "coast");
    expect(await outcome(inspect("geometry_overflow"))).toMatchObject(refusal);
    const features = await tableFeatures(testAccountScope(), "geometry_overflow");
    expect(features.ok).toBe(true);
    expect(features.featureCount).toBe(4);
    expect(Buffer.byteLength(JSON.stringify(features))).toBeGreaterThan(33_554_432);
  });

  it("does not exempt an unregistered native geometry column", async () => {
    await seed("secondary", `SELECT ST_Point(0,0) AS geometry, ${geometryOfBytes(3_000_000)} AS other`, 1, "geometry");
    expect(await outcome(inspect("secondary"))).toMatchObject(refusal);
  });

  it("retains legacy geometry-family healing and its final envelope value", async () => {
    await seed("legacy", "SELECT ST_Point(1,2) AS geometry", 1, "geometry");
    metadataDb().prepare("UPDATE data_tables SET geometry_type = 'MIXED' WHERE id = 'legacy'").run();
    expect((await inspect("legacy")).geometryType).toBe("POINT");
    expect(listTables()[0].geometryType).toBe("POINT");
  });

  it("reserves the healed geometry family before decoding the final preview value", async () => {
    await seed("healed", "SELECT ST_Point(1,2) AS geometry, repeat('x', 1000000) AS payload FROM range(33)", 33, "geometry");
    metadataDb().prepare("UPDATE data_tables SET geometry_type = 'POINT' WHERE id = 'healed'").run();
    const base = Buffer.byteLength(JSON.stringify(await inspect("healed")));
    metadataDb().prepare("UPDATE data_tables SET geometry_type = 'MIXED', source_filename = ? WHERE id = 'healed'").run("m".repeat(33_554_432 - base + 1));
    let decoded = 0;
    const original = DuckDBVarCharVector.prototype.getItem;
    vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
      const value = original.call(this, index);
      if (value?.length === 1000000) decoded++;
      return value;
    });
    expect(await outcome(inspect("healed"))).toMatchObject(refusal);
    expect(decoded).toBe(32);
  });

  it("counts only returned rows, preserves every inspection field and exact nested conversions", async () => {
    await seed("shape", "SELECT range AS id, CASE WHEN range = 50 THEN repeat('x', 2097151) ELSE 'é' END AS value, {'a': [1::BIGINT, NULL], 'b': chr(10)} AS nested, ST_Point(1,2) AS geometry FROM range(51)", 51, "geometry");
    const answer = await inspect("shape");
    expect(Object.keys(answer).sort()).toEqual(["columns", "createdAt", "crsAssumed", "file", "format", "geometryColumn", "geometryType", "headerSuspect", "id", "importedAt", "inputs", "name", "owner", "preview", "projectIds", "qualifiedName", "rowCount", "sizeBytes", "source", "sourceFilename", "sourceParams"].sort());
    expect(answer.rowCount).toBe(51); expect(answer.preview).toHaveLength(50);
    expect(answer.preview[0]).toEqual({ id: "0", value: "é", nested: { a: ["1", null], b: "\n" }, geometry: "POINT (1 2)" });
    expect(answer.preview[49].id).toBe("49");
    expect(answer.projectIds).toEqual([]); expect(answer.inputs).toBeNull();
    expect(answer.owner).toEqual({ name: "test-account", sqlName: "test_account" });
  });

  it("keeps layer admission/render, complete downloads, Data listing and owner deletion separate from refused inspection", async () => {
    const artifact = await seed("wide", "SELECT range AS id, repeat('x', 2097153) AS payload, ST_Point(0,0) AS geometry FROM range(20)", 20, "geometry");
    expect(await outcome(inspect("wide"))).toMatchObject(refusal);
    const map = createMap(testAccountScope(), "wide");
    const layer = await createLayer(testAccountScope(), map.id, { name: "wide", sql: "SELECT * FROM wide" }, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })!.editRevision });
    const rendered = await renderLayer(testAccountScope(), layer);
    expect(rendered.ok).toBe(true); expect(rendered.featureCount).toBe(20);
    expect(Buffer.byteLength(JSON.stringify(rendered))).toBeGreaterThan(33_554_432);
    expect((await tableFeatures(testAccountScope(), "wide")).featureCount).toBe(20);
    const downloaded = await download(request("wide", "/export?format=csv"), params("wide"));
    expect(downloaded.status).toBe(200);
    const metrics = await measure(downloaded.body!);
    expect(metrics).toMatchObject({ lines: 21, xs: 20 * 2_097_153 });
    expect(metrics.size).toBeGreaterThan(33_554_432);
    expect(metrics.size).toBe(Number(downloaded.headers.get("content-length")));
    for (const file of [await exportQueryResult(testAccountScope(), "SELECT * FROM wide", "csv"), await exportLayerResult(testAccountScope(), layer, "csv")]) {
      try { expect(await measure(createReadStream(file.path))).toEqual(metrics); } finally { await file.cleanup(); }
    }
    expect((await listTablesWithSize(testAccountScope())).map(table => table.name)).toContain("wide");
    const deleted = await DELETE(request("wide", "", "DELETE"), params("wide"));
    expect(deleted.status).toBe(204);
    await retirementsSettled();
    expect(listTables()).toEqual([]); await expect(access(artifact)).rejects.toThrow();
  });
});
