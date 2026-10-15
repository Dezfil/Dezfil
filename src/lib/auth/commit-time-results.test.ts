import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { fileMap } from "@/lib/metadata/projects";
import { createMap, mapWithLayers } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { renderMapImage, renderQueueState } from "@/lib/export/render-image";
import { requireRenderStanding } from "@/lib/export/render-standing";
import { lookAtMap, lookDefinition, setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import { lookRetention } from "@/lib/export/look-retention";
import { layerDownloadTickets } from "@/lib/export/layer-download-tickets";
import { tileScratchDir } from "@/lib/tiles/paths";
import { readHold } from "@/lib/test-support/read-hold";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { fileDataset, shareProject, unfileDataset } from "@/lib/test-support/sharing";
import { GET as layerExport } from "@/app/api/layers/[id]/export/[format]/route";
import { POST as look } from "@/app/api/maps/look/route";
import { GET as image } from "@/app/api/maps/look/[renderId]/route";
import { POST as queryPrepare, GET as queryDownload } from "@/app/api/query/export/route";
import { POST as projectPrepare } from "@/app/api/projects/[id]/export/route";
import type { AccountScope } from "./scope";

/**
 * Work that outlives its request, checked when it commits.
 *
 * Pat owns project P; Ada, its editor, files her map M (one layer reading her
 * `roads`) and `roads` there; Bob is a viewer of P. Ada also owns project Q
 * holding her map N and her `parks`.
 *
 * A prepared layer download whose layer, or a dataset it drew that someone
 * else owns, left the claimant's reach between the ticket and the claim is
 * refused on the claim. A server render and a look check ask again, at every
 * phase where they ask whether the account is still active, whether it still
 * reaches the map. A project export checks every selected member against the
 * initiator's reach as the archive completes and fails by name, never a
 * thinner archive. Completed results already issued (a look image, a query
 * download) stay with their initiator after reach is withdrawn.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let roads: string, parks: string, M: string, N: string;
const png = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(180) });

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "commit-time-results-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); lookRetention.resetForTests();
  scopes = Object.fromEntries(["pat", "ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  for (const name of ["roads", "parks"]) {
    const file = path.join(directory, `${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\nada ${name},1,2\n`);
    const id = (await ingestFile(scopes.ada, file, `${name}.csv`)).id;
    if (name === "roads") roads = id; else parks = id;
  }
  shareProject("pat", "P", [["ada", "editor"], ["bob", "viewer"]], [roads]);
  shareProject("ada", "Q", [], [parks]);
  M = createMap(scopes.ada, "Survey").id;
  N = createMap(scopes.ada, "Parks").id;
  fileMap(M, "P"); fileMap(N, "Q");
  for (const [map, layer, table] of [[M, "LM", "roads"], [N, "LN", "parks"]]) {
    metadataDb().prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'time', 'time')`).run(layer, map, table, `SELECT sentinel, ST_Point(lon, lat) AS geom FROM ${table}`, JSON.stringify(defaultStyle(null)));
  }
  setLookDriverForTests({ launch: async () => ({ render: async () => ({ png, consumed: JSON.stringify({ map: M, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [] }) }), close: async () => {}, kill() {} }) });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await layerDownloadTickets.dispose(); setLookDriverForTests(null); lookRetention.resetForTests();
  closeMetadataDb(); resetQueryInstance();
  await rm(directory, { recursive: true, force: true });
});

function request(account: string, url: string, method = "GET", body?: unknown) {
  return testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
}
const withdrawMap = () => { fileMap(M, null); };
const removeBob = () => { metadataDb().prepare("DELETE FROM project_people WHERE project_id = 'P' AND account_id = 'bob'").run(); };

describe("a prepared layer download, claimed", () => {
  const download = (account: string, mode: string) => layerExport(request(account, `/api/layers/LM/export/csv?${mode}`), { params: Promise.resolve({ id: "LM", format: "csv" }) });
  async function prepare(account: string) {
    const prepared = await download(account, "__ui_prepare=1");
    expect(prepared.status).toBe(200);
    return (await prepared.json()).ticket as string;
  }

  it("is served while its source is still in reach", async () => {
    const ticket = await prepare("bob");
    const claimed = await download("bob", `__ui_download=${ticket}`);
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).toContain("ada roads");
  });

  it.each([
    ["its map was withdrawn from the project", withdrawMap],
    ["the claimant left the project", removeBob],
    ["a dataset it drew was withdrawn", () => { unfileDataset("P", roads); }],
  ])("is refused on the claim when %s after the ticket", async (_label, change) => {
    const ticket = await prepare("bob");
    change();
    const claimed = await download("bob", `__ui_download=${ticket}`);
    expect(claimed.status).toBe(400);
    expect(await claimed.json()).toEqual({ error: { code: "invalid_request", message: "This prepared download is no longer available." } });
    const status = await download("bob", `__ui_status=${ticket}`);
    expect(await status.json()).toEqual({ status: "failed" });
    await layerDownloadTickets.settlePrepared();
    expect((await readdir(tileScratchDir())).filter((name) => name.startsWith("export-"))).toEqual([]);
  });

  it("stays its owner's when the owner withdraws their own map and dataset from the project", async () => {
    const ticket = await prepare("ada");
    withdrawMap(); unfileDataset("P", roads);
    const claimed = await download("ada", `__ui_download=${ticket}`);
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).toContain("ada roads");
  });
});

describe("a server render and a look check", () => {
  it("ask again at each phase whether the caller still reaches the map", async () => {
    vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "1");
    const gate = readHold("render driver");
    let launches = 0;
    const input = { mapId: M, definition: lookDefinition(mapWithLayers(scopes.bob, M), "light"), baseUrl: "http://instance.test", credential: "fixture",
      standing: () => requireRenderStanding(scopes.bob, M),
      driver: { launch: async () => { launches += 1; return { render: async () => { await gate.engage(); return { png }; }, close: async () => {}, kill() {} }; } } };
    const first = renderMapImage(scopes.bob, input).then((value) => ({ value }), (error) => ({ error }));
    let second: typeof first | undefined;
    try {
      await gate.beforeMutation();
      second = renderMapImage(scopes.bob, input).then((value) => ({ value }), (error) => ({ error }));
      expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
      withdrawMap(); gate.release();
      for (const pending of [first, second]) expect(await pending).toMatchObject({ error: { code: "not_found", status: 404 } });
      expect(launches).toBe(1);
    } finally { gate.release(); await first; await second; }
  });

  it("refuses a look whose map left the caller's reach while it rendered, retaining nothing", async () => {
    const gate = readHold("look driver");
    const driver = { launch: async () => ({ render: async () => { await gate.engage(); return { png, consumed: JSON.stringify({ map: M, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [] }) }; }, close: async () => {}, kill() {} }) };
    const pending = lookAtMap(scopes.bob, { mapId: M, baseUrl: "http://instance.test", credential: "fixture", driver }).then((value) => ({ value }), (error) => ({ error }));
    try {
      await gate.beforeMutation();
      removeBob(); gate.release();
      expect(await pending).toMatchObject({ error: { code: "not_found", status: 404 } });
    } finally { gate.release(); await pending; }
    expect(lookRetention.sizeForTests().count).toBe(0);
  });
});

describe("a project export, as it completes", () => {
  const exportQ = (body: unknown) => projectPrepare(request("ada", "/api/projects/Q/export", "POST", body), { params: Promise.resolve({ id: "Q" }) });

  it("delivers the selection that is still in reach", async () => {
    const response = await exportQ({ maps: [N], datasets: [parks], file: "parks", datasetFormat: "csv", prepare: true });
    expect(response.status).toBe(200);
  });

  it("fails by name when a selected dataset is withdrawn while the archive is assembled", async () => {
    const run = DuckDBConnection.prototype.run;
    vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
      const result = await run.call(this, sql, ...args);
      if (sql.startsWith("COPY ")) metadataDb().prepare("DELETE FROM project_datasets WHERE project_id = 'Q' AND table_id = ?").run(parks);
      return result;
    });
    const response = await exportQ({ maps: [N], datasets: [parks], file: "parks", datasetFormat: "csv", prepare: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "export_failed",
      message: 'The dataset "parks" is not available to you, so the archive was not delivered.' } });
    expect((await readdir(path.join(directory, "exports"))).filter((name) => name.endsWith(".zip"))).toEqual([]);
  });

  it("fails by name when a selected map is withdrawn while the archive is assembled", async () => {
    const run = DuckDBConnection.prototype.run;
    vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
      const result = await run.call(this, sql, ...args);
      if (sql.startsWith("COPY ")) fileMap(N, null);
      return result;
    });
    const response = await exportQ({ maps: [N], datasets: [parks], file: "parks", datasetFormat: "csv", prepare: true });
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toBe('The map "Parks" is not available to you, so the archive was not delivered.');
  });
});

describe("completed results a member already holds", () => {
  it("stay retrievable after their reach is withdrawn: a look image and a query download", async () => {
    const made = await look(request("bob", "/api/maps/look", "POST", { mapId: M }));
    expect(made.status).toBe(200);
    const renderId = (await made.json()).render.id as string;
    const prepared = await queryPrepare(request("bob", "/api/query/export", "POST", { sql: "SELECT sentinel FROM ada.roads", format: "csv", prepare: true }));
    expect(prepared.status).toBe(200);
    const { ticket, key, format } = await prepared.json();
    removeBob();
    fileDataset("P", parks);
    const read = await image(request("bob", `/api/maps/look/${renderId}`), { params: Promise.resolve({ renderId }) });
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(Buffer.from(png));
    const downloaded = await queryDownload(request("bob", `/api/query/export?ticket=${ticket}&key=${key}&format=${format}`));
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toContain("ada roads");
    // Neither grants a new look at what Bob no longer reaches.
    expect((await look(request("bob", "/api/maps/look", "POST", { mapId: M }))).status).toBe(404);
  });
});
