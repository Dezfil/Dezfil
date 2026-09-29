import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import path from "node:path";
import { copyFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { metadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { inspectTable, exportTable, removeTable } from "@/lib/table-service";
import { boundedEvaluation } from "@/lib/query/bounded";
import { readHold } from "@/lib/test-support/read-hold";
import { refreshTable } from "@/lib/ingest/refresh";
import * as dependencies from "@/lib/metadata/owned-tables";
import { retirementsSettled } from "@/lib/ingest/retire";
import * as retirement from "@/lib/ingest/retire";
import * as builder from "./build";
import * as reader from "./read";
import { clearGeometry, inspectGeometry, previewGeometry, setGeometry } from "./service";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";

let dir: string;
let remoteHold: ReturnType<typeof readHold> | null = null;
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: async () => {
  await remoteHold?.engage();
  const { Readable } = await import("node:stream");
  return { statusCode: 200, headers: { "content-type": "text/csv" }, body: Readable.from(['payload,x,y\n"POINT (50 60)",70,80\n']) };
} }));
beforeEach(async () => { dir = await setupGeometryTest(); remoteHold = null; });
afterEach(async () => { remoteHold?.release(); vi.restoreAllMocks(); await cleanupGeometryTest(dir); });
const wkt = { format: "wkt", columns: ["payload"] } as const;
const pair = { format: "pair", columns: ["x", "y"] } as const;
async function base() { return stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y"); }
function holdBuild() {
  const gate = readHold("prepared artifact");
  const build = builder.buildGeometryArtifact;
  vi.spyOn(builder, "buildGeometryArtifact").mockImplementationOnce(async (...args) => { const built = await build(...args); await gate.engage(); return built; });
  return gate;
}
it.each(["set", "clear", "refresh"])("a running set fences a competing %s before it can build", async operation => {
  const t = await stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y", { source: "url", sourceParams: { url: "https://fixture.test/data.csv", group: "group" } });
  const sibling = await stored("SELECT 'POINT (1 2)' payload, 3 x, 4 y", { source: "url", sourceParams: { url: "https://fixture.test/data.csv", group: "group" } });
  const gate = holdBuild(), run = setGeometry(testAccountScope(), t.name, reader.geometryRevision(t), wkt); void run.catch(() => {});
  try {
    await gate.beforeMutation();
    const competing = operation === "set" ? setGeometry(testAccountScope(), sibling.name, reader.geometryRevision(sibling), pair) : operation === "clear" ? clearGeometry(testAccountScope(), sibling.name, reader.geometryRevision(sibling)) : refreshTable(testAccountScope(), sibling.name);
    await expect(competing).rejects.toMatchObject({ code: operation === "refresh" ? "refresh_in_flight" : "geometry_in_flight", status: 409 });
    expect(getTableByName(sibling.name)).toEqual(sibling);
  } finally { gate.release(); await run; }
});
it.each(["set", "clear"])("URL group refresh fences a competing %s in another member", async operation => {
  const t = await stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y", { source: "url", sourceParams: { url: "https://fixture.test/data.csv", group: "group" } });
  const sibling = await stored("SELECT 'POINT (1 2)' payload", { source: "url", sourceParams: { url: "https://fixture.test/data.csv", group: "group" } });
  remoteHold = readHold("URL fetch");
  const run = refreshTable(testAccountScope(), t.name); void run.catch(() => {});
  try {
    await remoteHold.beforeMutation();
    await expect(operation === "set" ? setGeometry(testAccountScope(), sibling.name, reader.geometryRevision(sibling), wkt) : clearGeometry(testAccountScope(), sibling.name, reader.geometryRevision(sibling))).rejects.toMatchObject({ code: "geometry_in_flight", status: 409 });
  } finally { remoteHold.release(); await run; }
});
it.each(["delete-reclaim", "identity", "generation"])("prepared set cannot publish after %s and leaves no candidate", async fault => {
  const t = await base(), gate = holdBuild();
  const run = setGeometry(testAccountScope(), t.name, reader.geometryRevision(t), wkt).then(value => ({ value }), error => ({ error }));
  let replacementFile = t.file;
  try {
    await gate.beforeMutation();
    if (fault === "delete-reclaim") { await removeTable(testAccountScope(), t.name); const replacement = await stored("SELECT 90 x, 80 y", { name: t.name }); replacementFile = replacement.file; }
    if (fault === "identity") metadataDb().prepare("UPDATE data_tables SET id = 'reclaimed-id' WHERE id = ?").run(t.id);
    if (fault === "generation") {
      replacementFile = "tables/new-generation.parquet";
      await copyFile(path.join(process.env.DEZFIL_DATA_DIR!,t.file),path.join(process.env.DEZFIL_DATA_DIR!,replacementFile));
      metadataDb().prepare("UPDATE data_tables SET file = ? WHERE id = ?").run(replacementFile,t.id);
    }
    const before = getTableByName(t.name);
    gate.release();
    expect(await run).toMatchObject({ error: { code: fault === "generation" ? "input_changed" : "not_found" } });
    expect(getTableByName(t.name)).toEqual(before);
    await retirementsSettled();
    const expected = fault === "generation" ? [path.basename(t.file),path.basename(replacementFile)].sort() : [path.basename(replacementFile)];
    expect((await readdir(path.join(process.env.DEZFIL_DATA_DIR!,"tables"))).sort()).toEqual(expected);
  } finally { gate.release(); await run; }
});
it.each(["candidates", "preview", "sql", "export"])("captured %s reader survives two actual swaps and then retires old files", async kind => {
  const raw = await base(); const first = await setGeometry(testAccountScope(), raw.name,reader.geometryRevision(raw),wkt);
  await retirementsSettled();
  const table = first.table, oldFile = path.join(process.env.DEZFIL_DATA_DIR!,table.file);
  const gate = readHold(`${kind} reader`);
  if (kind === "candidates" || kind === "preview") {
    const original = reader.geometryColumns;
    vi.spyOn(reader,"geometryColumns").mockImplementationOnce(async (...args) => { await gate.engage(); return original(...args); });
  }
  if (kind === "export") {
    const run = DuckDBConnection.prototype.run;
    let once = true;
    vi.spyOn(DuckDBConnection.prototype,"run").mockImplementation(async function(this: DuckDBConnection, sql,...args) {
      if (once && sql.includes("FORMAT csv, HEADER")) { once=false; await gate.engage(); }
      return run.call(this,sql,...args);
    });
  }
  const reading = kind === "candidates" ? inspectGeometry(testAccountScope(), table.name) : kind === "preview" ? previewGeometry(testAccountScope(), table.name,first.revision,wkt) : kind === "export" ? exportTable(testAccountScope(), table.name,"csv") : boundedEvaluation(async conn => { await gate.engage(); return (await conn.runAndReadAll(`SELECT ST_AsText(geometry) shape FROM ${table.name}`)).getRowObjectsJson(); });
  void reading.catch(() => {});
  try {
    await gate.beforeMutation();
    const second = await setGeometry(testAccountScope(), table.name,first.revision,pair);
    const secondFile = path.join(process.env.DEZFIL_DATA_DIR!,second.table.file);
    await clearGeometry(testAccountScope(), table.name,second.revision);
    expect(existsSync(oldFile)).toBe(true); expect(existsSync(secondFile)).toBe(true);
    gate.release(); const result = await reading;
    if (kind === "candidates") expect(result).toMatchObject({ revision: first.revision, geometryRecord: { columns: ["payload"] } });
    if (kind === "preview") expect(result).toMatchObject({ revision: first.revision, extent: [10,20,10,20] });
    if (kind === "sql") expect(result).toEqual([{ shape: "POINT (10 20)" }]);
    if (kind === "export") {
      const exported = result as Awaited<ReturnType<typeof exportTable>>;
      expect(await readFile(exported.path,"utf8")).toContain("POINT (10 20)"); await exported.cleanup();
    }
    await retirementsSettled(); expect(existsSync(oldFile)).toBe(false); expect(existsSync(secondFile)).toBe(false);
  } finally { gate.release(); await reading.catch(() => {}); }
});
it("late legacy classification cannot overwrite a new geometry class", async () => {
  const raw = await base(); const first = await setGeometry(testAccountScope(), raw.name,reader.geometryRevision(raw),wkt);
  metadataDb().prepare("UPDATE data_tables SET geometry_type = 'MIXED' WHERE id = ?").run(raw.id);
  const gate = readHold("late classification"), original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype,"runAndReadAll").mockImplementation(async function(this: DuckDBConnection,sql,...args) {
    const result = await original.call(this,sql,...args);
    if (sql.includes("SELECT DISTINCT ST_GeometryType") && sql.includes("LIMIT 5")) await gate.engage();
    return result;
  });
  const pending = inspectTable(testAccountScope(), raw.name); void pending.catch(() => {});
  try {
    await gate.beforeMutation(); await clearGeometry(testAccountScope(), raw.name,first.revision);
    gate.release(); expect((await pending).geometryType).toBe("POINT");
    expect(getTableByName(raw.name)?.geometryType).toBeNull();
  } finally { gate.release(); await pending.catch(() => {}); }
});
it.each(["retirement", "tiles"])("committed %s cleanup failure still answers success", async fault => {
  const t=await base(); const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  if (fault === "retirement") vi.spyOn(retirement,"retireArtifact").mockImplementationOnce(()=>{throw new Error("cleanup failed");});
  else vi.spyOn(dependencies,"ownedDependentLayerIds").mockImplementationOnce(()=>{throw new Error("tile dependency read failed");});
  const result=await setGeometry(testAccountScope(), t.name,reader.geometryRevision(t),wkt);
  expect(result.table.file).not.toBe(t.file); expect(getTableByName(t.name)?.file).toBe(result.table.file);
  expect(warn).toHaveBeenCalled();
});
it("a revision from a reclaimed name refuses as not found, while a replaced generation conflicts", async () => {
  const t=await base(),revision=reader.geometryRevision(t);
  await removeTable(testAccountScope(), t.name);
  const replacement=await stored("SELECT 'POINT (90 80)' payload",{name:t.name});
  await expect(async()=>previewGeometry(testAccountScope(), t.name,revision,wkt)).rejects.toMatchObject({code:"not_found",status:404});
  const set=await setGeometry(testAccountScope(), t.name,reader.geometryRevision(replacement),wkt);
  await expect(async()=>previewGeometry(testAccountScope(), t.name,reader.geometryRevision(replacement),wkt)).rejects.toMatchObject({code:"input_changed",status:409});
  expect(getTableByName(t.name)?.file).toBe(set.table.file);
});
it("refresh refuses a changed generation with input_changed and cleans its candidate", async () => {
  const t=await stored("SELECT 'POINT (10 20)' payload",{source:"url",sourceParams:{url:"https://fixture.test/data.csv"}});
  remoteHold=readHold("refresh generation");
  const pending=refreshTable(testAccountScope(), t.name).then(value=>({value}),error=>({error}));
  try {
    await remoteHold.beforeMutation();
    const replacement="tables/new-generation.parquet";
    await copyFile(path.join(process.env.DEZFIL_DATA_DIR!,t.file),path.join(process.env.DEZFIL_DATA_DIR!,replacement));
    metadataDb().prepare("UPDATE data_tables SET file = ? WHERE id = ?").run(replacement,t.id);
    remoteHold.release();
    expect(await pending).toMatchObject({error:{code:"input_changed",status:409}});
    expect(getTableByName(t.name)?.file).toBe(replacement);
    expect((await readdir(path.join(process.env.DEZFIL_DATA_DIR!,"tables"))).sort()).toEqual([path.basename(t.file),path.basename(replacement)].sort());
  } finally { remoteHold.release(); await pending; }
});
