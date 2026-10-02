import { readFilingRevisions } from "@/lib/test-support/edit-basis";
import { DuckDBConnection } from "@duckdb/node-api";
import { readHold } from "@/lib/test-support/read-hold";
import { exportQueryResult } from "@/lib/export/layer-export";
import { renderMapImage, renderQueueState } from "@/lib/export/render-image";
import { lookDefinition } from "@/lib/export/map-look";
import { mapWithLayers } from "@/lib/map-service";
import { tileScratchDir } from "@/lib/tiles/paths";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import { createMap } from "@/lib/map-service";
import { createProject } from "@/lib/metadata/projects";
import { defaultStyle } from "@/lib/style/defaults";
import { resetQueryInstance } from "@/lib/duckdb";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import { lookRetention } from "@/lib/export/look-retention";
import { layerDownloadTickets } from "@/lib/export/layer-download-tickets";
import { AssistantRunStore } from "@/lib/assistant/runs";
import { POST as look } from "@/app/api/maps/look/route";
import { GET as image } from "@/app/api/maps/look/[renderId]/route";
import { GET as layerExport } from "@/app/api/layers/[id]/export/[format]/route";
import { POST as queryPrepare, GET as queryDownload } from "@/app/api/query/export/route";
import { POST as projectPrepare, GET as projectDownload } from "@/app/api/projects/[id]/export/route";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string, maps: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
const png = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(180) });
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "receipts-")); process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetQueryInstance(); lookRetention.resetForTests(); maps = {};
  for (const id of accounts) {
    maps[id] = createMap(testAccountScope(undefined, id), `Private ${id}`).id;
    metadataDb().prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'time', 'time')`).run(id, maps[id], id, `SELECT '${id}' sentinel, ST_Point(1, 2) geom`, JSON.stringify(defaultStyle(null)));
  }
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  setLookDriverForTests({ launch: async () => ({ render: async () => ({ png, consumed: JSON.stringify({ map: maps.alice, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [] }) }), close: async () => {}, kill() {} }) });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await layerDownloadTickets.dispose(); setLookDriverForTests(null); lookRetention.resetForTests();
  closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = initialDir;
  await rm(directory, { recursive: true, force: true });
});
function request(account: string, url: string, method = "GET", body?: unknown, kind = "session") {
  const req = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(req), "Downloads");
    req.headers.delete("cookie"); req.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return req;
}
async function sameRefusal(hidden: Response, missing: Response) {
  expect(hidden.status).toBe(missing.status); expect(hidden.status).toBeGreaterThanOrEqual(400);
  expect(await hidden.json()).toEqual(await missing.json());
}
it.each(["session", "token"])("keeps retained renders private after map deletion for %s callers", async kind => {
  const made = await look(request("alice", "/api/maps/look", "POST", { mapId: maps.alice }, kind));
  expect(made.status).toBe(200); const id = (await made.json()).render.id as string;
  metadataDb().prepare("DELETE FROM maps WHERE id = ?").run(maps.alice);
  for (const account of ["bob", "admin"]) for (const variant of ["full", "thumbnail"]) {
    const read = (renderId: string) => image(request(account, `/api/maps/look/${renderId}?variant=${variant}`, "GET", undefined, kind), { params: Promise.resolve({ renderId }) });
    await sameRefusal(await read(id), await read("missing"));
  }
  const owned = await image(request("alice", `/api/maps/look/${id}`, "GET", undefined, kind), { params: Promise.resolve({ renderId: id }) });
  expect(owned.status).toBe(200); expect(Buffer.from(await owned.arrayBuffer())).toEqual(Buffer.from(png));
});
it.each(["status", "release", "download"])("keeps a deleted layer's prepared %s private without consuming its ticket", async mode => {
  const call = (account: string, ticket: string) => layerExport(request(account, `/api/layers/alice/export/csv?${mode === "download" ? "__ui_download" : "__ui_status"}=${ticket}${mode === "release" ? "&__ui_release=1" : ""}`), { params: Promise.resolve({ id: "alice", format: "csv" }) });
  const prepared = await layerExport(request("alice", "/api/layers/alice/export/csv?__ui_prepare=1"), { params: Promise.resolve({ id: "alice", format: "csv" }) });
  expect(prepared.status).toBe(200); const { ticket } = await prepared.json();
  metadataDb().prepare("DELETE FROM layers WHERE id = 'alice'").run();
  for (const account of ["bob", "admin"]) await sameRefusal(await call(account, ticket), await call(account, "missing"));
  const downloaded = await layerExport(request("alice", `/api/layers/alice/export/csv?__ui_download=${ticket}`), { params: Promise.resolve({ id: "alice", format: "csv" }) });
  expect(downloaded.status).toBe(200); expect(await downloaded.text()).toContain("alice");
});
it.each(["session", "token"])("keeps standalone query download receipts private for %s callers", async kind => {
  const response = await queryPrepare(request("alice", "/api/query/export", "POST", { sql: "SELECT 'private-alice' sentinel", format: "csv", prepare: true }, kind));
  expect(response.status).toBe(200); const { ticket, key, format } = await response.json();
  const read = (account: string, value: string) => queryDownload(request(account, `/api/query/export?ticket=${value}&key=${key}&format=${format}`, "GET", undefined, kind));
  for (const account of ["bob", "admin"]) await sameRefusal(await read(account, ticket), await read(account, "missing"));
  expect(await (await read("alice", ticket)).text()).toContain("private-alice");
});
it.each(["session", "token"])("keeps project archives private after deleting their source for %s callers", async kind => {
  const project = createProject(testAccountScope(undefined, "alice"), { name: "Private", members: { ...{ addMaps: [maps.alice] }, expectedRevisions: readFilingRevisions({ addMaps: [maps.alice] }, undefined) } });
  const params = { params: Promise.resolve({ id: project.id }) };
  const response = await projectPrepare(request("alice", `/api/projects/${project.id}/export`, "POST", { maps: [maps.alice], file: "private", prepare: true }, kind), params);
  expect(response.status).toBe(200); const { ticket, key } = await response.json();
  metadataDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  metadataDb().prepare("DELETE FROM maps WHERE id = ?").run(maps.alice);
  const read = (account: string, value: string) => projectDownload(request(account, `/api/projects/${project.id}/export?ticket=${value}&key=${key}`, "GET", undefined, kind), params);
  for (const account of ["bob", "admin"]) await sameRefusal(await read(account, ticket), await read(account, "missing"));
  const owned = await read("alice", ticket); expect(owned.status).toBe(200); expect((await owned.arrayBuffer()).byteLength).toBeGreaterThan(0);
});
it("refuses an assistant reservation without an authenticated service scope", () => {
  const store = new AssistantRunStore();
  const reserve = store.reserve.bind(store) as () => unknown;
  expect(reserve).toThrow(expect.objectContaining({ code: "authentication_required" }));
});

it("discards query export files when the initiating account becomes inactive during execution", async () => {
  const scope = testAccountScope(undefined, "alice"), run = DuckDBConnection.prototype.run;
  let copied = false;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function(this: DuckDBConnection, sql, ...args) {
    const result = await run.call(this, sql, ...args);
    if (sql.startsWith("COPY ")) { copied = true; metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); }
    return result;
  });
  await expect(exportQueryResult(scope, "SELECT 1 sentinel", "csv")).rejects.toMatchObject({ code: "authentication_required" });
  expect(copied).toBe(true); expect((await readdir(tileScratchDir())).filter(name => name.startsWith("export-"))).toEqual([]);
});
it("refuses a render withdrawn in the queue before launch and drops a late active render", async () => {
  vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "1");
  const scope = testAccountScope(undefined, "alice"), gate = readHold("render driver");
  let launches = 0;
  const input = { mapId: maps.alice, definition: lookDefinition(mapWithLayers(scope, maps.alice), "light"), baseUrl: "http://instance.test", credential: "fixture",
    driver: { launch: async () => { launches++; return { render: async () => { await gate.engage(); return { png }; }, close: async () => {}, kill() {} }; } } };
  const first = renderMapImage(scope, input).then(value => ({ value }), error => ({ error }));
  let second: typeof first | undefined;
  try {
    await gate.beforeMutation(); second = renderMapImage(scope, input).then(value => ({ value }), error => ({ error }));
    expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); gate.release();
    for (const pending of [first, second]) expect(await pending).toMatchObject({ error: { code: "authentication_required" } });
    expect(launches).toBe(1); expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  } finally { gate.release(); await first; await second; }
});
it("keeps a prepared ticket frozen while inactive and restores the same owner's access on reactivation", async () => {
  const scope = testAccountScope(undefined, "alice");
  const file = await exportQueryResult(scope, "SELECT 'private' sentinel", "csv");
  const binding = { layerId: "deleted-output", format: "csv" as const };
  const ticket = layerDownloadTickets.prepare(scope, binding, { ...file, size: 17 });
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  for (const action of [() => layerDownloadTickets.status(scope, ticket, binding), () => layerDownloadTickets.claim(scope, ticket, binding)]) {
    expect(action).toThrow(expect.objectContaining({ code: "authentication_required" }));
  }
  expect(layerDownloadTickets.claim(testAccountScope(undefined, "admin"), ticket, binding)).toBeNull();
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(layerDownloadTickets.status(scope, ticket, binding)).toBe("prepared");
  const claimed = layerDownloadTickets.claim(scope, ticket, binding)!; expect(claimed).not.toBeNull();
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); claimed.complete();
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(layerDownloadTickets.status(scope, ticket, binding)).toBe("failed");
});
