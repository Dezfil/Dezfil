import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { requireReachedTable } from "@/lib/metadata/owned-tables";
import { createMap } from "@/lib/map-service";
import { inspectDataset } from "@/lib/table-service";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { fileDataset, shareProject, unfileDataset } from "@/lib/test-support/sharing";
import type { AccountScope } from "./scope";

/**
 * Datasets over reach. Pat owns project P, where Bob is a viewer and Edd an
 * editor; Cyd belongs to nothing. Ada (an editor of P) files `roads`, a
 * PostGIS snapshot `pg`, a derived `derived` (read from `roads`, `parks` and a
 * deleted input) and a sketch drawn on her unfiled map; she keeps `parks` to
 * herself. Bob owns a `roads` of his own. Every row names its owner.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
const ADA = { name: "ada", sqlName: "ada" };
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "dataset-reach-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["pat", "ada", "bob", "edd", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  const like = (id: string, name: string, extra: Partial<DataTable>): DataTable => ({ ...tables["ada.roads"], id, name, createdAt: "2026-01-01T00:00:00.000Z", ...extra });
  const unfiled = createMap(scopes.ada, "Private sketches");
  tables["ada.pg"] = like("pg", "pg", { source: "postgis", sourceParams: { connectionId: "conn-1", connectionName: "Warehouse", schema: "secret_schema", table: "secret_table" } });
  tables["ada.derived"] = like("derived", "derived", { source: "operation", sourceParams: { operation: "sql_step", sql: "SELECT * FROM roads, parks",
    inputs: [{ id: tables["ada.roads"].id, name: "roads" }, { id: tables["ada.parks"].id, name: "parks" }, { id: "gone", name: "gone" }] } });
  tables["ada.sketch"] = like("sketch", "sketch", { source: "sketch", sourceParams: { mapId: unfiled.id, mapName: "Private sketches", layerId: "layer" } });
  for (const key of ["ada.pg", "ada.derived", "ada.sketch"]) insertTable(scopes.ada, tables[key]);
  shareProject("pat", "P", [["ada", "editor"], ["bob", "viewer"], ["edd", "editor"]],
    ["ada.roads", "ada.pg", "ada.derived", "ada.sketch"].map((key) => tables[key].id));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, method = "GET", params: Record<string, string> = {}, body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as unknown : null };
}
const route = {
  tables: () => import("@/app/api/tables/route"),
  table: () => import("@/app/api/tables/[name]/route"),
  catalogue: () => import("@/app/api/catalogue/tables/route"),
  refresh: () => import("@/app/api/tables/[name]/refresh/route"),
  geometry: () => import("@/app/api/tables/[name]/geometry/route"),
};
type Listed = { id: string; name: string; qualifiedName: string; owner: { name: string; sqlName: string }; sourceParams: Record<string, unknown> | null; projectIds: string[]; source: string };
const listing = async (account: string, query = "") => (await call(account, route.tables, `/api/tables${query}`)).body as Listed[];
const byId = (rows: Listed[]) => new Map(rows.map((row) => [row.id, row]));

describe("listing datasets over reach", () => {
  it("lists exactly the reached datasets, each with its owner and the name its reader would type", async () => {
    const bob = byId(await listing("bob"));
    expect(new Set(bob.keys())).toEqual(new Set([tables["bob.roads"].id, tables["ada.roads"].id, "pg", "derived", "sketch"]));
    expect(bob.get(tables["bob.roads"].id)).toMatchObject({ name: "roads", qualifiedName: "roads", owner: { name: "bob", sqlName: "bob" } });
    expect(bob.get(tables["ada.roads"].id)).toMatchObject({ name: "roads", qualifiedName: "ada.roads", owner: ADA, projectIds: ["P"] });
    const ada = byId(await listing("ada"));
    expect(new Set(ada.keys())).toEqual(new Set([tables["ada.roads"].id, tables["ada.parks"].id, "pg", "derived", "sketch"]));
    expect(ada.get(tables["ada.roads"].id)).toMatchObject({ qualifiedName: "roads", owner: ADA, projectIds: ["P"] });
    expect(ada.get(tables["ada.parks"].id)).toMatchObject({ qualifiedName: "parks", projectIds: [] });
    expect((await listing("cyd"))).toEqual([]);
    for (const row of [...bob.values(), ...ada.values()]) expect(JSON.stringify(row)).not.toContain("@example.test");
  });

  it("shows another owner's dataset without connection facts or a map its reader cannot reach, and the owner's as stored", async () => {
    const bob = byId(await listing("bob"));
    expect(bob.get("pg")).toMatchObject({ source: "postgis", sourceParams: null });
    expect(bob.get("sketch")).toMatchObject({ source: "sketch", sourceParams: null });
    expect(bob.get("derived")!.sourceParams).toMatchObject({ operation: "sql_step" });
    expect(JSON.stringify([...bob.values()])).not.toMatch(/Warehouse|conn-1|secret_schema|secret_table|Private sketches/);
    const ada = byId(await listing("ada"));
    expect(ada.get("pg")!.sourceParams).toMatchObject({ connectionName: "Warehouse", schema: "secret_schema" });
    expect(ada.get("sketch")!.sourceParams).toMatchObject({ mapName: "Private sketches" });
  });

  it("narrows to any reached project and keeps none as the caller's own unfiled datasets; an unreached project is absent", async () => {
    expect(new Set((await listing("bob", "?project=P")).map((t) => t.id))).toEqual(new Set([tables["ada.roads"].id, "pg", "derived", "sketch"]));
    expect((await listing("bob", "?project=none")).map((t) => t.id)).toEqual([tables["bob.roads"].id]);
    expect((await listing("ada", "?project=none")).map((t) => t.id)).toEqual([tables["ada.parks"].id]);
    for (const project of ["P", "never-existed"]) {
      const refused = await call("cyd", route.tables, `/api/tables?project=${project}`);
      expect(refused.status).toBe(404);
      expect(refused.body).toEqual((await call("cyd", route.tables, "/api/tables?project=also-never")).body);
    }
  });
});

describe("the schema catalogue over reach", () => {
  type Page = { tables: { id: string; name: string; qualifiedName: string; owner: { sqlName: string } }[]; total: number; nextAfter: string | null };
  const page = async (account: string, query: string) => (await call(account, route.catalogue, `/api/catalogue/tables${query}`)).body as Page;

  it("pages by the name its reader would type, visiting two same-named datasets once each", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const next: Page = await page("bob", `?columns=0&limit=1${after === null ? "" : `&after=${encodeURIComponent(after)}`}`);
      expect(next.total).toBe(5);
      seen.push(...next.tables.map((table) => table.qualifiedName));
      after = next.nextAfter;
    } while (after !== null);
    expect(seen).toEqual(["ada.derived", "ada.pg", "ada.roads", "ada.sketch", "roads"]);
    expect((await page("ada", "?columns=0")).tables.map((t) => t.qualifiedName)).toEqual(["derived", "parks", "pg", "roads", "sketch"]);
    expect((await page("cyd", "?columns=0")).total).toBe(0);
  });

  it("addresses a dataset by the name its reader would type, and refuses one out of reach as a missing one", async () => {
    expect((await page("bob", "?names=ada.roads")).tables).toMatchObject([{ id: tables["ada.roads"].id, name: "roads", owner: { sqlName: "ada" } }]);
    expect((await page("bob", "?names=roads")).tables).toMatchObject([{ id: tables["bob.roads"].id }]);
    expect((await page("bob", "?project=P&columns=0")).total).toBe(4);
    expect((await page("bob", "?project=none&columns=0")).tables.map((t) => t.qualifiedName)).toEqual(["roads"]);
    const missing = await call("bob", route.catalogue, "/api/catalogue/tables?names=ada.never");
    for (const [account, query] of [["bob", "?names=ada.parks"], ["bob", "?names=parks"], ["cyd", "?names=ada.roads"], ["cyd", "?project=P"]]) {
      const refused = await call(account, route.catalogue, `/api/catalogue/tables${query}`);
      expect(refused.status, `${account} ${query}`).toBe(404);
      expect(refused.body, `${account} ${query}`).toEqual(missing.body);
    }
  });
});

describe("reading a reached dataset", () => {
  it("resolves recorded inputs within the reader's reach: the owner reads the unreachable as missing, anyone else reads only what they reach", async () => {
    const owner = await inspectDataset(scopes.ada, requireReachedTable(scopes.ada, "derived"));
    expect(owner).toMatchObject({ qualifiedName: "derived", owner: ADA, projectIds: ["P"] });
    expect(owner.inputs).toEqual([
      { id: tables["ada.roads"].id, name: "roads", currentName: "roads", missing: false },
      { id: tables["ada.parks"].id, name: "parks", currentName: "parks", missing: false },
      { id: "gone", name: "gone", missing: true, nameReclaimed: false },
    ]);
    const member = await inspectDataset(scopes.bob, requireReachedTable(scopes.bob, "derived"));
    expect(member).toMatchObject({ qualifiedName: "ada.derived", owner: ADA, projectIds: ["P"] });
    expect(member.inputs).toEqual([{ id: tables["ada.roads"].id, name: "roads", currentName: "roads", missing: false }]);
    expect(JSON.stringify(member.inputs)).not.toMatch(/parks|gone/);
    // An input that leaves the owner's reach reads exactly as a deleted one.
    insertTable(scopes.bob, { ...tables["ada.derived"], id: "bob-derived", name: "bob_derived", sourceParams: { operation: "sql_step",
      inputs: [{ id: tables["ada.roads"].id, name: "roads" }, { id: "gone", name: "gone" }] } });
    unfileDataset("P", tables["ada.roads"].id);
    const after = await inspectDataset(scopes.bob, requireReachedTable(scopes.bob, "bob-derived"));
    expect(after.inputs).toEqual([
      { id: tables["ada.roads"].id, name: "roads", missing: true, nameReclaimed: true },
      { id: "gone", name: "gone", missing: true, nameReclaimed: false },
    ]);
    expect(() => requireReachedTable(scopes.cyd, "derived")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("answers the owner's own read by its bare name with its owner and the name she would type", async () => {
    const read = await call("ada", route.table, "/api/tables/derived", "GET", { name: "derived" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: "derived", qualifiedName: "derived", owner: ADA, projectIds: ["P"] });
  });
});

describe("a dataset changes only by its owner", () => {
  it("leaves another owner's dataset untouched from an editor's and a viewer's seat, by every name they could send", async () => {
    const row = () => metadataDb().prepare("SELECT * FROM data_tables WHERE id = ?").get(tables["ada.roads"].id);
    const before = { row: row(), bytes: await readFile(path.join(directory, tables["ada.roads"].file)) };
    for (const account of ["bob", "edd"]) {
      for (const name of ["ada.roads", "ada.parks"]) {
        const attempts = [
          await call(account, route.table, `/api/tables/${name}`, "DELETE", { name }),
          await call(account, route.refresh, `/api/tables/${name}/refresh`, "POST", { name }),
          await call(account, route.geometry, `/api/tables/${name}/geometry?expectedRevision=r`, "DELETE", { name }),
          await call(account, route.geometry, `/api/tables/${name}/geometry`, "PUT", { name }, { expectedRevision: "r", choice: { format: "pair", columns: ["lon", "lat"] } }),
        ];
        for (const attempt of attempts) expect([403, 404], `${account} ${name}`).toContain(attempt.status);
      }
    }
    expect(row()).toEqual(before.row);
    expect(await readFile(path.join(directory, tables["ada.roads"].file))).toEqual(before.bytes);
    fileDataset("P", tables["ada.parks"].id);
    expect(byId(await listing("edd")).get(tables["ada.parks"].id)).toMatchObject({ qualifiedName: "ada.parks" });
  });
});
