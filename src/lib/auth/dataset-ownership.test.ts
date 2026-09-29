import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { insertTable, registerTable, type DataTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { createProject } from "@/lib/metadata/projects";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

const effects = vi.hoisted(() => ({ engine: vi.fn(), source: vi.fn(), tiles: vi.fn(async () => {}) }));
vi.mock("@/lib/duckdb", () => ({ withConnection: effects.engine, trustedH3Ready: vi.fn() }));
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: effects.source }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles, invalidateTileBuild: effects.tiles }));

let db: Database;
let maps: Record<string, string>;
let projects: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
const point = { kind: "point", geometry: { type: "Point", coordinates: [13, 52] } };
function record(name: string): DataTable {
  return { id: `id-${name}`, name, sourceFilename: `${name}.csv`, file: `tables/${name}.parquet`,
    format: "csv", geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false,
    rowCount: 1, source: "upload", sourceParams: null, createdAt: "time", importedAt: "time" };
}
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  maps = {}; projects = {};
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    maps[account] = createMap(scope, "Private map").id;
    projects[account] = createProject(scope, { name: "Private project" }, db).id;
    insertTable(scope, record(account), db);
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Datasets", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["data_tables", "maps", "layers", "projects", "project_datasets"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const cases = [
  ["inspect", "GET", "", undefined, () => import("@/app/api/tables/[name]/route")],
  ["delete", "DELETE", "", undefined, () => import("@/app/api/tables/[name]/route")],
  ["features", "GET", "/features", undefined, () => import("@/app/api/tables/[name]/features/route")],
  ["export", "GET", "/export?format=geoparquet", undefined, () => import("@/app/api/tables/[name]/export/route")],
  ["refresh", "POST", "/refresh", {}, () => import("@/app/api/tables/[name]/refresh/route")],
  ["geometry", "GET", "/geometry", undefined, () => import("@/app/api/tables/[name]/geometry/route")],
  ["geometry preview", "POST", "/geometry/preview", { expectedRevision: "stale", choice: { format: "wkt", columns: ["wkt"] } }, () => import("@/app/api/tables/[name]/geometry/preview/route")],
  ["geometry set", "PUT", "/geometry", { expectedRevision: "stale", choice: { format: "wkt", columns: ["wkt"] } }, () => import("@/app/api/tables/[name]/geometry/route")],
  ["geometry clear", "DELETE", "/geometry?expectedRevision=stale", undefined, () => import("@/app/api/tables/[name]/geometry/route")],
  ["sketch read", "GET", "/features", undefined, () => import("@/app/api/sketches/[name]/features/route")],
  ["sketch append", "POST", "/features", { feature: point }, () => import("@/app/api/sketches/[name]/features/route")],
  ["sketch cascade", "DELETE", "", undefined, () => import("@/app/api/sketches/[name]/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ name: string }> }) => Promise<Response>;
it.each(cases)("refuses hidden dataset %s like absence before protected work", async (_label, method, suffix, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method];
  const before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const responses = [];
    for (const name of [other, "missing"]) responses.push(await handler(input(account, `/api/tables/${name}${suffix}`, method, body, kind), { params: Promise.resolve({ name }) }));
    expect(responses.map(r => r.status)).toEqual([404, 404]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(snapshot()).toEqual(before);
    expect(effects.engine).not.toHaveBeenCalled(); expect(effects.source).not.toHaveBeenCalled(); expect(effects.tiles).not.toHaveBeenCalled();
  }
});
it.each(["session", "token"])("selects only the %s owner's dataset list before decoding private content", async kind => {
  const { GET } = await import("@/app/api/tables/route");
  for (const account of accounts) {
    const response = await GET(input(account, "/api/tables", "GET", undefined, kind));
    expect(response.status).toBe(200);
    expect((await response.json()).map((t: DataTable) => t.name)).toEqual([account]);
  }
  db.prepare("UPDATE data_tables SET source_params = 'private-invalid-json' WHERE name = 'bob'").run();
  expect((await GET(input("alice", "/api/tables"))).status).toBe(200);
  expect(await (await GET(input("empty", "/api/tables"))).json()).toEqual([]);
});
it("keeps upload suffixes local to the owner, including distinct durable identities", () => {
  const ids = new Set<string>();
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    const table = registerTable(scope, record(`roads-${account}`), "Roads.csv", db);
    expect(table.name).toBe("roads"); ids.add(table.id);
    expect(registerTable(scope, record(`more-${account}`), "Roads.csv", db).name).toBe("roads_2");
    expect(db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(table.id)).toEqual({ owner_id: account });
  }
  expect(ids.size).toBe(3);
});
it("refuses hidden project contexts before upload reception or remote fetch", async () => {
  const upload = await import("@/app/api/tables/route");
  const remote = await import("@/lib/ingest/remote");
  const before = snapshot();
  const responses = [];
  for (const project of [projects.bob, "missing"]) {
    responses.push(await upload.POST(input("alice", `/api/tables?project=${project}`, "POST")));
    await expect(remote.importFromUrl(testAccountScope(db, "alice"), "https://example.test/data.csv", "data", project))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  }
  expect(responses.map(r => r.status)).toEqual([404, 404]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect(snapshot()).toEqual(before); expect(effects.source).not.toHaveBeenCalled(); expect(effects.engine).not.toHaveBeenCalled();
});
it("requires ownership for sketch creation at the service boundary", async () => {
  const { createSketch } = await import("@/lib/sketch/store");
  for (const id of [maps.bob, "missing"]) await expect(createSketch(testAccountScope(db, "alice"), id, point))
    .rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(effects.engine).not.toHaveBeenCalled();
});
it("requires authentication at dataset and catalogue adapters", async () => {
  for (const load of [() => import("@/app/api/tables/route"), () => import("@/app/api/catalogue/tables/route")]) {
    expect((await (await load()).GET(socketRequest(new Request("http://instance.test/api/tables")))).status).toBe(401);
  }
});
it("filters catalogue totals, pages, names and project references before artifact access", async () => {
  const { catalogueRecords } = await import("@/lib/metadata/table-catalogue");
  const query = { limit: 1, columns: 0, columnOffset: 0 };
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    const result = catalogueRecords(scope, query);
    expect(result.total).toBe(1); expect(result.more).toBe(false);
    expect(result.records.map(r => r.name)).toEqual([account]);
    for (const name of accounts.filter(a => a !== account).concat("missing")) {
      expect(() => catalogueRecords(scope, { ...query, names: [account, name] })).toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
    }
    expect(() => catalogueRecords(scope, { ...query, project: projects[accounts.find(a => a !== account)!] })).toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
  }
  expect(effects.engine).not.toHaveBeenCalled();
});
it("selects URL and OSM group members inside the account before decoding provenance", async () => {
  const { urlGroupMembers } = await import("@/lib/ingest/gdal-formats");
  const { osmGroupMembers } = await import("@/lib/osm/import");
  for (const source of ["url", "osm"] as const) {
    for (const account of accounts) insertTable(testAccountScope(db, account), {
      ...record(`${account}_${source}`), source, sourceParams: { group: "shared-group" },
    }, db);
    const members = source === "url" ? urlGroupMembers : osmGroupMembers;
    for (const account of accounts) expect(members(testAccountScope(db, account), "shared-group").map(t => t.name)).toEqual([`${account}_${source}`]);
  }
  db.prepare("UPDATE data_tables SET source_params = 'unreadable' WHERE owner_id = 'bob'").run();
  expect(urlGroupMembers(testAccountScope(db, "alice"), "shared-group")).toHaveLength(1);
});
