import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import * as secrets from "@/lib/secrets";
import { insertConnection } from "@/lib/metadata/connections";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

const source = vi.hoisted(() => ({ test: vi.fn(), browse: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/postgis/access", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/postgis/access")>(),
  testConnection: source.test, browseRemoteTables: source.browse, withPg: source.attach,
}));
let db: Database;
const accounts = ["alice", "bob", "admin"];
const health = { serverVersion: "source-version", postgisVersion: "spatial-version" };
const values = { host: "db.example.test", port: 5432, database: "private", username: "reader", password: "private-secret", ssl: true };
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const account of accounts) insertConnection(testAccountScope(db, account), { ...values, password: `${account}-${values.password}`, id: account, name: account }, db);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.spyOn(secrets, "decryptSecret");
  source.test.mockReset().mockResolvedValue(health);
  source.browse.mockReset().mockResolvedValue({ tables: [] });
  source.attach.mockReset().mockRejectedValue(new Error("Source must not be contacted"));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, id: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test/api/connections/postgis/${id}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Connections", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function rows() { return db.prepare("SELECT * FROM pg_connections ORDER BY id").all(); }
const cases = [
  ["edit", "PATCH", { name: "New name" }, () => import("@/app/api/connections/postgis/[id]/route")],
  ["delete", "DELETE", undefined, () => import("@/app/api/connections/postgis/[id]/route")],
  ["test", "POST", {}, () => import("@/app/api/connections/postgis/[id]/test/route")],
  ["browse", "GET", undefined, () => import("@/app/api/connections/postgis/[id]/tables/route")],
  ["preview", "POST", { schema: "public", table: "private" }, () => import("@/app/api/connections/postgis/[id]/preview/route")],
  ["snapshots", "GET", undefined, () => import("@/app/api/connections/postgis/[id]/snapshots/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
it.each(cases)("refuses hidden connection %s like absence before secrets, source access or health writes", async (_label, method, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method];
  const before = rows();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const responses = [];
    for (const id of [other, "missing"]) responses.push(await handler(input(account, id, method, body, kind), { params: Promise.resolve({ id }) }));
    expect(responses.map(r => r.status)).toEqual([404, 404]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(rows()).toEqual(before);
    expect(secrets.decryptSecret).not.toHaveBeenCalled();
    for (const effect of Object.values(source)) expect(effect).not.toHaveBeenCalled();
  }
});
it.each(["session", "token"])("lists only the %s owner's connection details", async kind => {
  const { GET } = await import("@/app/api/connections/postgis/route");
  for (const account of accounts) {
    const handler = GET as unknown as (request: Request) => Promise<Response>;
    const response = await handler(input(account, "", "GET", undefined, kind));
    expect(response.status).toBe(200);
    const listed = await response.json();
    expect(listed.map((c: { id: string }) => c.id)).toEqual([account]);
    expect(JSON.stringify(listed)).not.toContain(values.password);
  }
  expect(secrets.decryptSecret).not.toHaveBeenCalled();
});
it("keeps connection names and rename conflicts within the account", async () => {
  const { POST } = await import("@/app/api/connections/postgis/route");
  const { PATCH } = await import("@/app/api/connections/postgis/[id]/route");
  const ids = new Set<string>();
  for (const account of accounts) {
    const response = await POST(input(account, "", "POST", { ...values, name: "Roads", ownerId: "bob" }));
    expect(response.status).toBe(201);
    const created = await response.json(); ids.add(created.id);
    expect(db.prepare("SELECT owner_id FROM pg_connections WHERE id = ?").get(created.id)).toEqual({ owner_id: account });
    const renamed = await PATCH(input(account, created.id, "PATCH", { name: "Renamed" }), { params: Promise.resolve({ id: created.id }) });
    expect(renamed.status).toBe(200);
  }
  expect(ids.size).toBe(3);
});
it("refuses unowned stored provenance before decrypting or contacting the source", async () => {
  const { insertTable } = await import("@/lib/metadata/tables");
  const { refreshTable } = await import("@/lib/ingest/refresh");
  const scope = testAccountScope(db, "alice");
  const before = rows();
  for (const id of ["bob", "missing"]) {
    insertTable(scope, { id: `snapshot-${id}`, name: `snapshot_${id}`, sourceFilename: null,
      file: `tables/${id}.parquet`, format: "geoparquet", geometryColumn: null, geometryType: null,
      crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "time", importedAt: "time",
      source: "postgis", sourceParams: { connectionId: id, schema: "public", table: "private" } }, db);
    await expect(refreshTable(scope, `snapshot_${id}`)).rejects.toMatchObject({ status: 404, code: "not_found" });
  }
  expect(rows()).toEqual(before);
  expect(secrets.decryptSecret).not.toHaveBeenCalled();
  for (const effect of Object.values(source)) expect(effect).not.toHaveBeenCalled();
});
it("requires scope at connection services and refuses hidden health writes", async () => {
  const { requireTarget } = await import("@/lib/postgis/import");
  const { recordConnectionHealth, recordConnectionFailure } = await import("@/lib/postgis/status");
  const { ApiError } = await import("@/lib/api/errors");
  const { listConnections, getConnection, connectionPassword } = await import("@/lib/metadata/connections");
  const before = rows();
  const scope = testAccountScope(db, "alice");
  for (const id of ["bob", "admin", "missing"]) {
    expect(() => requireTarget(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(getConnection(scope, id)).toBeNull();
    expect(connectionPassword(scope, id)).toBeNull();
    expect(() => recordConnectionHealth(scope, id, health)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => recordConnectionFailure(scope, id, new ApiError("connection_failed", "private failure", 502))).toThrow(expect.objectContaining({ status: 404 }));
  }
  for (const invalid of [undefined, null, { accountId: "alice" }]) {
    const missing = invalid as Parameters<typeof requireTarget>[0];
    expect(() => requireTarget(missing, "alice")).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => listConnections(missing)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => recordConnectionHealth(missing, "alice", health)).toThrow(expect.objectContaining({ status: 401 }));
  }
  expect(rows()).toEqual(before); expect(secrets.decryptSecret).not.toHaveBeenCalled();
});
it.each(["create", "edit", "test", "failed test", "browse", "preview"])("discards the late %s result when its owner is deactivated", async operation => {
  const service = await import("@/lib/postgis/connection-service");
  const { previewPostgis } = await import("@/lib/postgis/preview");
  const { ApiError } = await import("@/lib/api/errors");
  const scope = testAccountScope(db, "alice"), before = rows();
  const deactivate = () => db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  source.test.mockImplementation(async () => {
    deactivate();
    if (operation === "failed test") throw new ApiError("connection_failed", "Authentication failed", 502);
    return health;
  });
  source.browse.mockImplementation(async () => { deactivate(); return { tables: [{ table: "late" }] }; });
  const result = operation === "create" ? service.createConnection(scope, { ...values, name: "Late" })
    : operation === "edit" ? service.editConnection(scope, "alice", { database: "new" })
    : operation === "browse" ? service.browseConnection(scope, "alice")
    : operation === "preview" ? previewPostgis(scope, "alice", { schema: "public", table: "private" }, async () => {
      deactivate(); return { rows: [{ private: "late" }], columns: [], connectionHealth: health };
    }) : service.testSavedConnection(scope, "alice");
  await expect(result).rejects.toMatchObject({ status: 401 });
  expect(rows()).toEqual(before);
});
it.each(["deactivated", "deleted"])("cleans a built import when the connection owner is %s before commit", async mode => {
  const { importPostgis } = await import("@/lib/postgis/import");
  const { writeFile, mkdir, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const scope = testAccountScope(db, "alice");
  const before = rows(); let artifact = "";
  await expect(importPostgis(scope, { connectionId: "alice", schema: "public", table: "private" }, async (_target, _recipe, file) => {
    artifact = file; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "candidate");
    if (mode === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    else db.prepare("DELETE FROM pg_connections WHERE id = 'alice'").run();
    return { geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, connectionHealth: health };
  })).rejects.toMatchObject({ status: mode === "deactivated" ? 401 : 404 });
  await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  expect(db.prepare("SELECT * FROM data_tables").all()).toEqual([]);
  expect(rows()).toEqual(mode === "deactivated" ? before : before.filter(row => (row as { id: string }).id !== "alice"));
});
it("lists only owned snapshots even when foreign provenance points to the connection", async () => {
  const { insertTable } = await import("@/lib/metadata/tables");
  const { connectionSnapshots } = await import("@/lib/postgis/connection-service");
  for (const account of accounts) insertTable(testAccountScope(db, account), { id: `snapshot-${account}`, name: `snapshot_${account}`, sourceFilename: null,
    file: `tables/${account}.parquet`, format: "geoparquet", geometryColumn: null, geometryType: null,
    crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "time", importedAt: "time",
    source: "postgis", sourceParams: { connectionId: "alice", schema: "public", table: "private" } }, db);
  expect(connectionSnapshots(testAccountScope(db, "alice"), "alice").snapshots.map(t => t.id)).toEqual(["snapshot-alice"]);
  db.prepare("UPDATE data_tables SET source_params = 'private invalid json' WHERE owner_id = 'bob'").run();
  expect(connectionSnapshots(testAccountScope(db, "alice"), "alice").snapshots).toHaveLength(1);
});
it("uses the owner's credentials for source work and isolates stored health by durable id", async () => {
  const { testSavedConnection, browseConnection } = await import("@/lib/postgis/connection-service");
  const { previewPostgis } = await import("@/lib/postgis/preview");
  const { getConnection } = await import("@/lib/metadata/connections");
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    const before = rows().filter(row => (row as { id: string }).id !== account);
    const tested = await testSavedConnection(scope, account);
    expect(tested).toMatchObject({ id: account, status: "connected" });
    expect(source.test).toHaveBeenLastCalledWith(expect.objectContaining({ id: account, password: `${account}-${values.password}` }));
    const checked = getConnection(scope, account);
    source.browse.mockResolvedValueOnce({ tables: [{ table: account }] });
    expect(await browseConnection(scope, account)).toEqual({ tables: [{ table: account }] });
    expect(source.browse).toHaveBeenLastCalledWith(expect.objectContaining({ password: `${account}-${values.password}` }));
    const preview = await previewPostgis(scope, account, { schema: "public", table: "data" }, async target => {
      expect(target.password).toBe(`${account}-${values.password}`);
      return { rows: [{ sentinel: account }], columns: [], connectionHealth: health };
    });
    expect(preview.rows).toEqual([{ sentinel: account }]);
    expect(getConnection(scope, account)).toEqual(checked);
    expect(rows().filter(row => (row as { id: string }).id !== account)).toEqual(before);
  }
});
it.each(["deactivated", "deleted"])("cleans a refresh candidate when connection access becomes %s", async mode => {
  const imports = await import("@/lib/postgis/import");
  const { refreshTable } = await import("@/lib/ingest/refresh");
  const { insertTable } = await import("@/lib/metadata/tables");
  const { writeFile, mkdir, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const scope = testAccountScope(db, "alice"); let artifact = "";
  insertTable(scope, { id: "snapshot", name: "snapshot", sourceFilename: null, file: "tables/original.parquet",
    format: "geoparquet", geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false,
    rowCount: 1, createdAt: "time", importedAt: "time", source: "postgis",
    sourceParams: { connectionId: "alice", schema: "public", table: "private" } }, db);
  const before = db.prepare("SELECT * FROM data_tables").all();
  vi.spyOn(imports, "buildPostgisArtifact").mockImplementation(async (_target, _recipe, file) => {
    artifact = file; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "candidate");
    if (mode === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    else db.prepare("DELETE FROM pg_connections WHERE id = 'alice'").run();
    return { geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 2, connectionHealth: health };
  });
  await expect(refreshTable(scope, "snapshot")).rejects.toMatchObject({ status: mode === "deactivated" ? 401 : 404 });
  await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  expect(db.prepare("SELECT * FROM data_tables").all()).toEqual(before);
  expect(db.prepare("SELECT last_checked_at FROM pg_connections WHERE id = 'alice'").get()).toEqual(mode === "deactivated" ? { last_checked_at: null } : undefined);
});
