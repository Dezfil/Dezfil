import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, writeFile, readdir, rm, readFile, access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { importFromUrl } from "@/lib/ingest/remote";
import { Readable } from "node:stream";
import { refreshTable } from "@/lib/ingest/refresh";
import { refreshUnit, beginRefresh, endRefresh, resetRefreshFences } from "@/lib/ingest/fence";
import { retirementsSettled } from "@/lib/ingest/retire";
import { inspectTable, tableFeatures, exportTable, removeTable, listTablesWithSize, requireTable } from "@/lib/table-service";
import { readTableCatalogue } from "@/lib/table-catalogue";
import { createMap } from "@/lib/map-service";
import { createSketch, appendFeature, listFeatures, mapSketches, cascadeDeleteSketch } from "@/lib/sketch/store";
import { inspectGeometry, setGeometry, clearGeometry } from "@/lib/geometry/service";
import { getTableByName } from "@/lib/metadata/tables";
import { createProject } from "@/lib/metadata/projects";
import type { AccountScope } from "./scope";

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: transport.open }));

let directory: string;
let source: string;
let scopes: Record<string, AccountScope>;
const initialDir = process.env.DEZFIL_DATA_DIR!;
const accounts = ["alice", "bob", "admin"];
const point = { kind: "point", geometry: { type: "Point", coordinates: [13, 52] } };
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "datasets-"));
  process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
  scopes = Object.fromEntries(accounts.map(id => [id, testAccountScope(undefined, id)]));
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  source = path.join(directory, "source.csv");
  await writeFile(source, "sentinel,lat,lon\ninitial,52,13\n");
  transport.open.mockImplementation(sourceResponse);
});
afterEach(async () => {
  await retirementsSettled();
  vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance();
  process.env.DEZFIL_DATA_DIR = initialDir;
  await rm(directory, { recursive: true, force: true });
});
async function sourceResponse() { return { statusCode: 200, headers: {}, body: Readable.from([await readFile(source)]) }; }
async function namesOnDisk() { return (await readdir(path.join(directory, "tables")).catch(() => [])).sort(); }
function owner(id: string) { return (metadataDb().prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(id) as { owner_id: string }).owner_id; }

it("keeps identical upload and URL names separate through inspection, catalogue, geometry, refresh, export and delete", async () => {
  const tables = [];
  for (const account of accounts) {
    await writeFile(source, `sentinel,lat,lon\n${account},52,13\n`);
    const table = (await importFromUrl(scopes[account], "https://example.test/roads.csv", "roads")).tables[0];
    expect(table.name).toBe("roads"); expect(owner(table.id)).toBe(account); tables.push(table);
    expect((await ingestFile(scopes[account], source, "roads.csv")).name).toBe("roads_2");
  }
  expect(new Set(tables.map(t => t.id)).size).toBe(3);
  expect(new Set(tables.map(t => t.file)).size).toBe(3);
  for (const account of accounts) {
    const scope = scopes[account];
    expect((await inspectTable(scope, "roads")).preview[0].sentinel).toBe(account);
    expect((await tableFeatures(scope, "roads")).featureCount).toBe(1);
    const catalogue = await readTableCatalogue(scope, { limit: 1, columns: 64, columnOffset: 0 });
    expect(catalogue.total).toBe(2); expect(catalogue.tables[0].id).toBe(tables[accounts.indexOf(account)].id);
    expect(catalogue.nextAfter).toBe("roads");
    const second = await readTableCatalogue(scope, { limit: 1, columns: 64, columnOffset: 0, after: catalogue.nextAfter! });
    expect(second.tables.map(t => t.name)).toEqual(["roads_2"]); expect(second.nextAfter).toBeNull();
    const exported = await exportTable(scope, "roads", "csv");
    expect(await readFile(exported.path, "utf8")).toContain(account); await exported.cleanup();
  }
  const bobBefore = requireTable(scopes.bob, "roads");
  const revision = (await inspectGeometry(scopes.alice, "roads")).revision;
  await clearGeometry(scopes.alice, "roads", revision);
  expect(requireTable(scopes.bob, "roads")).toEqual(bobBefore);
  await writeFile(source, "sentinel,lat,lon\nrefreshed,53,14\n");
  const refreshed = await refreshTable(scopes.alice, "roads");
  expect(refreshed.id).toBe(tables[0].id); expect(owner(refreshed.id)).toBe("alice");
  expect((await inspectTable(scopes.alice, "roads")).preview[0].sentinel).toBe("refreshed");
  expect(requireTable(scopes.bob, "roads")).toEqual(bobBefore);
  await removeTable(scopes.alice, "roads");
  expect((await inspectTable(scopes.bob, "roads")).preview[0].sentinel).toBe("bob");
  await expect(access(path.join(directory, bobBefore.file))).resolves.toBeUndefined();
  expect((await ingestFile(scopes.alice, source, "roads.csv")).name).toBe("roads");
});

it("keeps same-name sketch mutations and cascades in their owning account", async () => {
  const maps = Object.fromEntries(accounts.map(id => [id, createMap(scopes[id], "Survey")]));
  const sketches = [];
  for (const id of accounts) {
    const sketch = await createSketch(scopes[id], maps[id].id, point, { expectedRevision: readEditRevision({ kind: "map", id: maps[id].id })?.editRevision });
    expect(sketch.table.name).toBe("survey_sketch"); expect(owner(sketch.table.id)).toBe(id); sketches.push(sketch);
    expect((await mapSketches(scopes[id], maps[id].id))[0].tableId).toBe(sketch.table.id);
  }
  await appendFeature(scopes.alice, "survey_sketch", point);
  expect(await listFeatures(scopes.alice, "survey_sketch")).toHaveLength(2);
  expect(await listFeatures(scopes.bob, "survey_sketch")).toHaveLength(1);
  await cascadeDeleteSketch(scopes.alice, "survey_sketch");
  expect(await listFeatures(scopes.bob, "survey_sketch")).toHaveLength(1);
  expect(metadataDb().prepare("SELECT id FROM layers WHERE id = ?").get(sketches[1].layerId)).toBeDefined();
});

it("does not let another owner's same name or provenance group claim a refresh fence", async () => {
  const a = (await importFromUrl(scopes.alice, "https://example.test/roads.csv")).tables[0];
  const b = (await importFromUrl(scopes.bob, "https://example.test/roads.csv")).tables[0];
  const first = refreshUnit(scopes.alice, a), second = refreshUnit(scopes.bob, b);
  beginRefresh(first, a.name);
  expect(() => beginRefresh(second, b.name)).not.toThrow();
  endRefresh(first); endRefresh(second);
  const groupA = refreshUnit(scopes.alice, { ...a, sourceParams: { group: "same-group" } });
  const groupB = refreshUnit(scopes.bob, { ...b, sourceParams: { group: "same-group" } });
  expect(groupA).not.toBe(groupB);
  const otherMember = refreshUnit(scopes.alice, { ...a, id: "other", sourceParams: { group: "same-group" } });
  expect(otherMember).toBe(groupA);
});

it("rechecks refresh authority after source work and removes its uncommitted artifact", async () => {
  const table = (await importFromUrl(scopes.alice, "https://example.test/roads.csv")).tables[0];
  const before = await namesOnDisk();
  transport.open.mockImplementationOnce(async () => {
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    return sourceResponse();
  });
  await expect(refreshTable(scopes.alice, table.name)).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  expect(await namesOnDisk()).toEqual(before); expect(getTableByName(table.name)).toEqual(table);
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(requireTable(scopes.alice, table.name)).toEqual(table);
});

it("rechecks project ownership after a source resolves and commits no imported dataset on refusal", async () => {
  const project = createProject(scopes.alice, { name: "Survey" });
  transport.open.mockImplementationOnce(async () => {
    metadataDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    return sourceResponse();
  });
  await expect(importFromUrl(scopes.alice, "https://example.test/roads.csv", "roads", project.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(await listTablesWithSize(scopes.alice)).toEqual([]); expect(await namesOnDisk()).toEqual([]);
});

it("requires explicit service scopes before resolving names or reading files", async () => {
  const table = await ingestFile(scopes.alice, source, "roads.csv");
  for (const invalid of [undefined, null, { accountId: "alice" }]) {
    const scope = invalid as AccountScope;
    for (const action of [() => inspectTable(scope, table.name), () => tableFeatures(scope, table.name),
      () => exportTable(scope, table.name, "geoparquet"), () => removeTable(scope, table.name), () => listTablesWithSize(scope),
      () => refreshTable(scope, table.name), () => inspectGeometry(scope, table.name),
      () => setGeometry(scope, table.name, "stale", { format: "wkt", columns: ["wkt"] }),
      () => clearGeometry(scope, table.name, "stale"), () => listFeatures(scope, table.name),
      () => readTableCatalogue(scope, { limit: 32, columns: 64, columnOffset: 0 })]) {
      await expect(Promise.resolve().then(async () => action())).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    }
  }
});

it.each(["upload", "sketch", "geometry"])("refuses deactivation after %s artifact construction and leaves no partial commit", async kind => {
  const map = createMap(scopes.alice, "Survey");
  const table = await ingestFile(scopes.alice, source, "roads.csv");
  const revision = (await inspectGeometry(scopes.alice, table.name)).revision;
  const before = await namesOnDisk();
  const rows = metadataDb().prepare("SELECT * FROM data_tables ORDER BY id").all();
  const original = DuckDBConnection.prototype.run;
  let held = false;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    const result = await original.call(this, sql, ...args);
    if (!held && /^COPY /i.test(sql.trim())) {
      held = true;
      metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    }
    return result;
  });
  const work = kind === "upload" ? () => ingestFile(scopes.alice, source, "new.csv")
    : kind === "sketch" ? () => createSketch(scopes.alice, map.id, point, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision })
    : () => setGeometry(scopes.alice, table.name, revision, { format: "pair", columns: ["lon", "lat"] });
  await expect(Promise.resolve().then(async () => work())).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  expect(held).toBe(true); expect(await namesOnDisk()).toEqual(before);
  expect(metadataDb().prepare("SELECT * FROM data_tables ORDER BY id").all()).toEqual(rows);
  expect(metadataDb().prepare("SELECT * FROM layers").all()).toEqual([]);
});
