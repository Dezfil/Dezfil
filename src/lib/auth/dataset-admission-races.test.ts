import { DuckDBConnection } from "@duckdb/node-api";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { readHold } from "@/lib/test-support/read-hold";
import { stored } from "@/lib/test-support/geometry";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getOwnedTableByName } from "@/lib/metadata/owned-tables";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { retirementsSettled } from "@/lib/ingest/retire";
import { refreshTable } from "@/lib/ingest/refresh";
import { importOsm } from "@/lib/osm/import";
import { inspectTable, removeTable } from "@/lib/table-service";

const overpass = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/osm/overpass", () => ({ fetchOverpass: overpass.fetch, overpassEndpoint: () => "https://example.test/overpass" }));
const payload = { elements: [
  { type: "node", id: 1, lat: 52.52, lon: 13.41, tags: { amenity: "cafe" } },
  { type: "node", id: 10, lat: 52.53, lon: 13.4 },
  { type: "node", id: 11, lat: 52.54, lon: 13.43 },
  { type: "way", id: 100, nodes: [10, 11], tags: { highway: "residential" } },
] };
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "admission-"));
  process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
  await mkdir(path.join(directory, "tables"));
  overpass.fetch.mockReset().mockResolvedValue({ response: payload });
});
afterEach(async () => {
  await retirementsSettled(); vi.restoreAllMocks();
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
  process.env.DEZFIL_DATA_DIR = initialDir;
  await rm(directory, { recursive: true, force: true });
});

it("keeps the admitted group deletion message and rolls back every surviving member", async () => {
  const scope = testAccountScope();
  await importOsm(scope, { selectors: ["amenity", "highway"], bbox: [13.3, 52.4, 13.5, 52.6], name: "group" });
  const before = getOwnedTableByName(scope, "group_points")!;
  const gate = readHold("group source");
  overpass.fetch.mockImplementationOnce(async () => { await gate.engage(); return { response: payload }; });
  const pending = refreshTable(scope, before.name).then(value => ({ value }), error => ({ error }));
  try {
    await gate.beforeMutation();
    await removeTable(scope, "group_lines");
    gate.release();
    expect(await pending).toMatchObject({ error: { code: "not_found", status: 404,
      message: 'Table "group_lines" was deleted while the group refresh ran; the group was left as it was.' } });
    expect(getOwnedTableByName(scope, before.name)).toEqual(before);
    expect(getOwnedTableByName(scope, "group_lines")).toBeNull();
    await retirementsSettled();
    expect(await readdir(path.join(directory, "tables"))).toEqual([path.basename(before.file)]);
  } finally { gate.release(); await pending; }
});

it.each(["delete-reclaim", "identity", "generation", "deactivation"])("late classification retains admission across %s", async fault => {
  const scope = testAccountScope();
  const table = await stored("SELECT ST_Point(1, 2) geom", { name: "legacy", geometryColumn: "geom", geometryType: "MIXED" });
  const gate = readHold("geometry classification"), original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function(this: DuckDBConnection, sql, ...args) {
    const result = await original.call(this, sql, ...args);
    if (sql.includes("SELECT DISTINCT ST_GeometryType") && sql.includes("LIMIT 5")) await gate.engage();
    return result;
  });
  const pending = inspectTable(scope, table.name); void pending.catch(() => {});
  try {
    await gate.beforeMutation();
    if (fault === "delete-reclaim") {
      await removeTable(scope, table.name);
      await stored("SELECT ST_GeomFromText('POLYGON ((0 0, 1 0, 1 1, 0 0))') geom", { name: table.name, geometryColumn: "geom", geometryType: "POLYGON" });
    } else if (fault === "identity") {
      metadataDb().prepare("UPDATE data_tables SET id = 'replacement' WHERE id = ?").run(table.id);
    } else if (fault === "generation") {
      metadataDb().prepare("UPDATE data_tables SET file = 'tables/new.parquet', geometry_type = 'POLYGON' WHERE id = ?").run(table.id);
    } else metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(scope.accountId);
    const before = metadataDb().prepare("SELECT * FROM data_tables ORDER BY id").all();
    gate.release();
    if (fault === "deactivation") await expect(pending).rejects.toMatchObject({ code: "authentication_required" });
    else expect((await pending).geometryType).toBe("POINT");
    expect(metadataDb().prepare("SELECT * FROM data_tables ORDER BY id").all()).toEqual(before);
  } finally { gate.release(); await pending.catch(() => {}); }
});
