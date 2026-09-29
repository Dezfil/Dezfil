import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "./execute";
import { boundedEvaluation } from "./bounded";
import { ApiError } from "@/lib/api/errors";
import { scopedDatasets } from "./access";
import { namedSql } from "./named-sql";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
const scope = () => testAccountScope();
beforeEach(async () => {
 directory = await mkdtemp(path.join(initialDir, "refusals-")); process.env.DEZFIL_DATA_DIR = directory;
 closeMetadataDb(); resetQueryInstance();
 const source = path.join(directory, "source.csv"); await writeFile(source, "name,lon,lat\nowned,1,2\n");
 await ingestFile(scope(), source, "roads.csv");
 await ingestFile(testAccountScope(undefined, "bob"), source, "hidden_roads.csv");
});
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
const failure = async (run: () => Promise<unknown>) => {
 const result = await run().then(() => null, error => error);
 expect(result).toBeInstanceOf(ApiError);
 const error = result as ApiError;
 return { code: error.code, message: error.message, status: error.status, extra: error.extra };
};
it("gives hidden and nonexistent table names the same failure without suggestions", async () => {
 const hidden = await failure(() => executeQuery(scope(), "SELECT * FROM hidden_roads"));
 const missing = await failure(() => executeQuery(scope(), "SELECT * FROM absent_roads"));
 expect(hidden).toEqual(missing);
 expect(hidden).toMatchObject({ code: "sql_error", status: 400, message: "The query refers to an unknown table." });
 expect(JSON.stringify(hidden)).not.toMatch(/hidden_roads|absent_roads|bob|roads|Candidate|Did you mean|read_parquet|tables\//);
 expect((await executeQuery(scope(), "SELECT name FROM roads")).preview).toEqual([{ name: "owned" }]);
});
it("does not expose internal artifact paths from a real engine read failure", async () => {
 const table = scopedDatasets(scope())[0], artifact = path.join(directory, table.file);
 const error = await failure(() => boundedEvaluation(async conn => {
  // Admission has already bound the owned artifact. Corrupt the admitted file
  // to exercise the native read diagnostic rather than a synthetic exception.
  await writeFile(artifact, "not a parquet artifact");
  await conn.runAndReadAll(await namedSql(conn, "SELECT * FROM roads"));
 }, { scope: scope() }));
 expect(error).toMatchObject({ code: "sql_error", status: 400 });
 expect(error.message).not.toMatch(/\.parquet|read_parquet|\/Users\/|\/private\/|PAR1|magic bytes/);
 expect(error.message).toBe("The query's dataset could not be read.");
});
it("retains useful input diagnostics and source positions without binder suggestions", async () => {
 const error = await failure(() => executeQuery(scope(), "SELECT unknown_field FROM roads"));
 expect(error.message).toContain('"unknown_field"');
 expect(error.message).not.toMatch(/Candidate|LINE|q\./);
 expect(error.extra).toEqual({ position: { line: 1, column: 8 } });
 const invalid = await failure(() => executeQuery(scope(), "SELECT CAST('abc' AS INTEGER)"));
 expect(invalid.message).toContain("'abc'");
});
it("uses the same safe refusal in query consumers and their degraded envelopes", async () => {
 const { createMap } = await import("@/lib/map-service");
 const { createLayer, renderLayer, baseFields, layerFieldStats } = await import("@/lib/layer-service");
 const { exportQueryResult } = await import("@/lib/export/layer-export");
 const { materialize } = await import("@/lib/operations/materialize");
 const { classifyFill, computeSizeScale } = await import("@/lib/style/classify");
 const { computeWidgetValues } = await import("@/lib/widget-service");
 const map = createMap(scope(), "Refusals"), layer = await createLayer(scope(), map.id, { name: "Roads", sql: "SELECT * FROM roads" });
 const sql = "SELECT * FROM hidden_roads", saved = { ...layer, sql };
 for (const run of [() => executeQuery(scope(), sql), () => classifyFill(scope(), sql, "lon", "continuous"), () => classifyFill(scope(), sql, "lon", "quantile"), () => computeSizeScale(scope(), sql, "lon", [1, 10]), () => baseFields(scope(), saved), () => layerFieldStats(scope(), saved, "name"), () => exportQueryResult(scope(), sql, "csv"), () => materialize(scope(), { name: "denied", sql, operation: "sql_step" })]) {
  expect(await failure(run)).toMatchObject({ code: "sql_error", status: 400, message: "The query refers to an unknown table." });
 }
 expect(await renderLayer(scope(), saved)).toMatchObject({ ok: false, error: { code: "sql_error", message: "The query refers to an unknown table." } });
 const widgets = [{ id: "count", type: "formula" as const, layerId: layer.id, title: "Count", field: null, agg: "count" as const, aggField: null, unit: null, note: null, format: null, visible: true }];
 expect(await computeWidgetValues(scope(), { ...map, widgets }, [saved], [])).toMatchObject({ widgets: [{ id: "count", errorCode: "sql_error", error: "The query refers to an unknown table." }] });
 expect(scopedDatasets(scope()).map(table => table.name)).toEqual(["roads"]);
});
