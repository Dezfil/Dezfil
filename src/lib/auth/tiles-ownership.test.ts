import { privateTileAccess } from "@/lib/tiles/access";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "./scope";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { ensureTiles, resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";
import { getTileRecord } from "@/lib/metadata/tiles";
import { tileArchivePath, tileScratchDir } from "@/lib/tiles/paths";
const effects = vi.hoisted(() => ({ export: vi.fn(), beforeExport: undefined as undefined | (() => Promise<void>), afterExport: undefined as undefined | (() => void), afterRename: undefined as undefined | (() => void), read: vi.fn() }));
vi.mock("@/lib/tiles/export", () => ({ exportGeoJsonSeq: async (...args: unknown[]) => {
  effects.export(...args); await effects.beforeExport?.();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(args[2] as string, [13, 14].map(lon => JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [lon, 52] }, properties: { value: lon } })).join("\n") + "\n");
  effects.afterExport?.(); return 2;
} }));
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => { await actual.rename(...args); effects.afterRename?.(); } }; });
vi.mock("@/lib/tiles/serve", async original => ({ ...await original<typeof import("@/lib/tiles/serve")>(), readTile: effects.read }));
let dir: string, previous: string | undefined, scopes: Record<string, AccountScope>, layers: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(async () => {
  previous = process.env.DEZFIL_DATA_DIR; dir = await mkdtemp(path.join(process.cwd(), ".claude/tiles-life-")); process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb(); resetTileBuilds(); effects.export.mockReset(); effects.read.mockReset(); effects.beforeExport = undefined; effects.afterExport = undefined; effects.afterRename = undefined;
  scopes = {}; layers = {};
  for (const account of accounts) {
    scopes[account] = testAccountScope(metadataDb(), account); const map = createMap(scopes[account], "Private map"); layers[account] = `layer-${account}`;
    metadataDb().prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES (?, ?, 'Private', ?, ?, 0, 'time', 'time')`).run(layers[account], map.id, `SELECT '${account}' AS value`, JSON.stringify(defaultStyle(null)));
  }
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(async () => {
  effects.beforeExport = undefined; effects.afterExport = undefined; effects.afterRename = undefined; await tileBuildsSettled(); resetTileBuilds(); closeMetadataDb();
  if (previous === undefined) delete process.env.DEZFIL_DATA_DIR; else process.env.DEZFIL_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});
function input(account: string) { return { layerId: layers[account], sql: `SELECT '${account}' AS value`, filters: [], geometryColumn: "geometry", columns: ["value"], projection: "" }; }
function build(account: string) { return ensureTiles(privateTileAccess(scopes[account], layers[account]), input(account)); }
function deactivate(account: string) { metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(account); }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
it("does not export a private build whose owner was deactivated while queued", async () => {
  const held = gate(); effects.beforeExport = () => held.promise;
  build("bob"); await vi.waitFor(() => expect(effects.export).toHaveBeenCalledOnce()); build("alice"); deactivate("alice"); held.release(); await tileBuildsSettled();
  expect(effects.export).toHaveBeenCalledOnce(); expect(getTileRecord(layers.bob)?.state).toBe("ready"); expect(existsSync(tileArchivePath(layers.alice))).toBe(false);
});
it.each(["export", "rename"])("removes staged and final archives after owner deactivation at %s", async phase => {
  if (phase === "export") effects.afterExport = () => deactivate("alice"); else effects.afterRename = () => deactivate("alice");
  build("alice"); await tileBuildsSettled(); expect(getTileRecord(layers.alice)?.state).not.toBe("ready"); expect(existsSync(tileArchivePath(layers.alice))).toBe(false); expect(await readdir(tileScratchDir())).toEqual([]);
});
it("withholds private tile bytes if activity is lost during the read", async () => {
  const { GET } = await import("@/app/api/layers/[id]/tiles/[z]/[x]/[y]/route");
  const request = testAccountRequest(new Request("http://instance.test/api/layers/x/tiles/0/0/0"), metadataDb(), "alice");
  effects.read.mockImplementation(async () => { deactivate("alice"); return new Uint8Array([1, 2, 3]); });
  const response = await GET(request, { params: Promise.resolve({ id: layers.alice, z: "0", x: "0", y: "0" }) });
  expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: { code: "authentication_required" } });
});
it.each(["session", "token"])("refuses hidden %s tile results without reading archives, including for administrators", async kind => {
  const { GET } = await import("@/app/api/layers/[id]/tiles/[z]/[x]/[y]/route");
  const { createApiToken } = await import("./credentials"), { requireRequestAuth } = await import("./http");
  const { privateTileStatus } = await import("@/lib/tiles/private-service");
  effects.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
  for (const account of accounts) {
    const request = testAccountRequest(new Request("http://instance.test/api/layers/x/tiles/0/0/0"), metadataDb(), account);
    if (kind === "token") { const token = createApiToken(requireRequestAuth(request), "Tiles"); request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`); }
    expect((await GET(request, { params: Promise.resolve({ id: layers[account], z: "0", x: "0", y: "0" }) })).status).toBe(200);
    effects.read.mockClear();
    const replies = [];
    for (const id of [layers[accounts.find(a => a !== account)!], "missing"]) {
      replies.push(await GET(request, { params: Promise.resolve({ id, z: "0", x: "0", y: "0" }) }));
      expect(() => privateTileStatus(scopes[account], id)).toThrow(expect.objectContaining({ status: 404 }));
    }
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json()); expect(effects.read).not.toHaveBeenCalled();
  }
});
it("refuses missing or forged account scopes and mixed-layer build capabilities before exporting", () => {
  const before = metadataDb().prepare("SELECT * FROM layer_tiles").all();
  for (const bad of [undefined, { accountId: "alice" }]) expect(() => privateTileAccess(bad as AccountScope, layers.alice)).toThrow(expect.objectContaining({ status: 401 }));
  expect(() => ensureTiles(privateTileAccess(scopes.alice, layers.alice), input("bob"))).toThrow(expect.objectContaining({ status: 404 }));
  for (const account of ["bob", "admin"]) expect(() => privateTileAccess(scopes[account], layers.alice)).toThrow(expect.objectContaining({ status: 404 }));
  const access = privateTileAccess(scopes.alice, layers.alice); deactivate("alice");
  expect(() => ensureTiles(access, input("alice"))).toThrow(expect.objectContaining({ status: 401 }));
  expect(effects.export).not.toHaveBeenCalled(); expect(metadataDb().prepare("SELECT * FROM layer_tiles").all()).toEqual(before);
});
it("completes separate real archives for three owners and exposes only their own status", async () => {
  const { privateTileStatus } = await import("@/lib/tiles/private-service");
  for (const account of accounts) build(account);
  await tileBuildsSettled();
  const actual = await vi.importActual<typeof import("@/lib/tiles/serve")>("@/lib/tiles/serve");
  for (const account of accounts) {
    expect(privateTileStatus(scopes[account], layers[account])).toMatchObject({ state: "ready", featureCount: 2 });
    expect(existsSync(tileArchivePath(layers[account]))).toBe(true); expect(await actual.tileArchiveInfo(layers[account])).not.toBeNull();
  }
  expect(effects.export.mock.calls.map(call => call[1].sql)).toEqual(accounts.map(account => input(account).sql));
});
it("lets only the owner delete and fence an in-flight private build", async () => {
  const held = gate(); effects.beforeExport = () => held.promise;
  const { removeLayer } = await import("@/lib/layer-removal");
  build("alice"); await vi.waitFor(() => expect(effects.export).toHaveBeenCalledOnce());
  for (const account of ["bob", "admin"]) await expect(removeLayer(scopes[account], layers.alice)).rejects.toMatchObject({ status: 404 });
  expect(getTileRecord(layers.alice)?.state).toBe("building");
  await removeLayer(scopes.alice, layers.alice); held.release(); await tileBuildsSettled();
  expect(getTileRecord(layers.alice)).toBeNull(); expect(existsSync(tileArchivePath(layers.alice))).toBe(false); expect(await readdir(tileScratchDir())).toEqual([]);
});
it("rebuilds after reactivation without inheriting an abandoned building or failure record", async () => {
  effects.afterExport = () => deactivate("alice"); build("alice"); await tileBuildsSettled(); expect(getTileRecord(layers.alice)).toBeNull();
  effects.afterExport = undefined; metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(build("alice").state).toBe("building"); await tileBuildsSettled(); expect(build("alice")).toMatchObject({ state: "ready", featureCount: 2 });
});
it("keeps publication authority separate from private activity and rechecks token revocation", async () => {
  const { publishMap, unpublishMap } = await import("@/lib/publish/publish-service"), { publishedTileAccess } = await import("@/lib/tiles/access");
  const mapId = (metadataDb().prepare("SELECT map_id FROM layers WHERE id = ?").get(layers.alice) as { map_id: string }).map_id;
  const { token } = publishMap(scopes.alice, mapId); const access = publishedTileAccess(token, layers.alice); deactivate("alice");
  ensureTiles(access, input("alice")); await tileBuildsSettled(); expect(getTileRecord(layers.alice)?.state).toBe("ready");
  expect(() => privateTileAccess(scopes.alice, layers.alice)).toThrow(expect.objectContaining({ status: 401 }));
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  effects.afterExport = () => unpublishMap(scopes.alice, mapId);
  ensureTiles(access, { ...input("alice"), projection: "changed" }); await tileBuildsSettled();
  expect(getTileRecord(layers.alice)).toBeNull(); expect(() => ensureTiles(access, input("alice"))).toThrow(expect.objectContaining({ status: 404 }));
});
it("replaces an inactive private queue entry with a valid published request for the same query", async () => {
  const { publishMap } = await import("@/lib/publish/publish-service"), { publishedTileAccess } = await import("@/lib/tiles/access");
  const mapId = (metadataDb().prepare("SELECT map_id FROM layers WHERE id = ?").get(layers.alice) as { map_id: string }).map_id;
  const { token } = publishMap(scopes.alice, mapId), held = gate(); effects.beforeExport = () => held.promise;
  build("bob"); await vi.waitFor(() => expect(effects.export).toHaveBeenCalledOnce()); build("alice"); deactivate("alice");
  ensureTiles(publishedTileAccess(token, layers.alice), input("alice")); held.release(); await tileBuildsSettled();
  expect(getTileRecord(layers.alice)?.state).toBe("ready"); expect(effects.export).toHaveBeenCalledTimes(2);
});
it("keeps the queue usable when abandoned-status cleanup hits a metadata failure", async () => {
  const records = await import("@/lib/metadata/tiles");
  effects.afterExport = () => { deactivate("alice"); vi.spyOn(records, "getTileRecord").mockImplementationOnce(() => { throw new Error("temporary metadata failure"); }); };
  build("alice");
  try {
    const result = await Promise.race([tileBuildsSettled().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))]);
    expect(result).toBe(true); expect(await readdir(tileScratchDir())).toEqual([]);
  } finally { resetTileBuilds(); }
  effects.afterExport = undefined; metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run(); build("alice"); await tileBuildsSettled(); expect(getTileRecord(layers.alice)?.state).toBe("ready");
});
