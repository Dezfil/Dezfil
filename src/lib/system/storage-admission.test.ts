import { importOsm } from "@/lib/osm/import";
import { importOverture } from "@/lib/overture/import";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { receiveUpload } from "@/lib/ingest/receive";
import { ingestSource } from "@/lib/ingest/gdal-formats";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { importPostgis } from "@/lib/postgis/import";
import { exportTable } from "@/lib/table-service";
import { exportLayerResult, exportQueryResult } from "@/lib/export/layer-export";
import { assembleProjectExport } from "@/lib/export/project-export";
import { createSketch } from "@/lib/sketch/store";
import { fetchTemplate } from "@/lib/templates/download";
import { copyTemplate } from "@/lib/templates/copy";
import { saveThumbnail, readThumbnail } from "@/lib/map-thumbnails";
import { materialize } from "@/lib/operations/materialize";
import { startRun } from "@/lib/operations/run";
import { renderMapImage } from "@/lib/export/render-image";
import { admitPictureWrite, publishPicture } from "@/lib/profile-pictures/store";
import { POINTS_VIZ } from "@/lib/viz";
import { admitStorageWrite } from "./storage-admission";
import { STORAGE_FULL_BYTES, STORAGE_MB } from "./storage-state";

const volume = vi.hoisted(() => ({ free: 0 }));
vi.mock("./storage-state", async original => {
  const actual = await original<typeof import("./storage-state")>();
  return { ...actual, readStorageState: () => ({ full: volume.free <= actual.STORAGE_FULL_BYTES, free: volume.free, total: 4 * actual.STORAGE_FULL_BYTES, threshold: actual.STORAGE_FULL_BYTES }) };
});
const root = process.env.DEZFIL_DATA_DIR!;
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(path.join(root, "admission-")); vi.stubEnv("DEZFIL_DATA_DIR", folder); closeMetadataDb();
  volume.free = STORAGE_FULL_BYTES * 3;
});
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); });
const refused = (work: () => unknown) => expect(Promise.resolve().then(work)).rejects.toMatchObject({ code: "storage_full", status: 409 });
const files = () => readdirSync(folder, { recursive: true }).map(String).filter(name => !name.startsWith("metadata.sqlite")).sort();

it("refuses every writing road before it leaves an artifact, retaining the existing picture and file", async () => {
  const scope = testAccountScope();
  const map = createMap(scope, "Kept");
  await saveThumbnail(scope, map.id, Buffer.from("previous"));
  const source = path.join(folder, "input.csv"); writeFileSync(source, "x,y\n1,2\n");
  const { tables: [table] } = await ingestSource(scope, source, "input.csv");
  const picture = admitPictureWrite(scope.accountId, scope.accountId);
  const before = files(); volume.free = STORAGE_FULL_BYTES;
  const roads = [
    () => receiveUpload(new Request("http://instance.test/api/tables", { method: "POST", body: "data" }), scope.accountId),
    () => ingestSource(scope, source, "input.csv"),
    () => importFromUrl(scope, "https://example.test/data.csv"),
    () => refreshTable(scope, table.name),
    () => importOsm(scope, {} as Parameters<typeof importOsm>[1]),
    () => importOverture(scope, {} as Parameters<typeof importOverture>[1]),
    () => importPostgis(scope, { connectionId: "absent", schema: "public", table: "points" }),
    () => exportTable(scope, table.name, "csv"),
    () => exportTable(scope, table.name, "geojson"),
    () => exportQueryResult(scope, "SELECT 1", "csv"),
    () => exportLayerResult(scope, { name: "Layer", sql: "SELECT ST_Point(1,2) AS geom", filters: [], viz: POINTS_VIZ }, "csv"),
    () => assembleProjectExport(scope, "absent", { maps: [], tables: [], recipes: [], file: "export" }),
    () => createSketch(scope, map.id, {}),
    () => fetchTemplate(scope, "absent", null),
    () => copyTemplate(scope, "absent"),
    () => saveThumbnail(scope, map.id, Buffer.from("new")),
    () => publishPicture(picture, Buffer.from("new"), () => {}),
    () => materialize(scope, { sql: "SELECT 1 AS n", name: "result", operation: "sql" }),
    () => startRun(scope, { operation: "sql", parameters: { sql: "SELECT 1 AS n" } }),
    () => renderMapImage(scope, { mapId: map.id } as Parameters<typeof renderMapImage>[1]),
  ];
  try { for (const road of roads) { await refused(road); expect(files()).toEqual(before); } }
  finally { picture.release(); }
  expect(await readThumbnail(scope, map.id)).toEqual(Buffer.from("previous"));
  const download = await exportTable(scope, table.name, "geoparquet"); await download.cleanup();
  expect(metadataDb().prepare("SELECT COUNT(*) AS n FROM operation_jobs").get()).toEqual({ n: 0 });
});

it("admits only declarations that fit above the threshold, including the exact boundary", async () => {
  volume.free = STORAGE_FULL_BYTES + 10;
  expect(() => admitStorageWrite(10)).not.toThrow();
  await refused(() => admitStorageWrite(11));
  await refused(() => receiveUpload(new Request("http://instance.test/api/tables", { method: "POST", headers: { "content-length": "11" }, body: "not read" })));
  expect(files()).toEqual([]);
});

it("stops an undeclared stream at the threshold and removes its partial", async () => {
  const scope = testAccountScope();
  const boundary = "storage-boundary";
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\n\r\n`));
    controller.enqueue(Buffer.alloc(2 * STORAGE_MB, 65));
    setTimeout(() => { volume.free = STORAGE_FULL_BYTES; controller.enqueue(Buffer.alloc(4 * STORAGE_MB, 65)); }, 20);
  } });
  await refused(() => receiveUpload(new Request("http://instance.test/api/tables", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: stream, duplex: "half" } as RequestInit), scope.accountId));
  expect(files().filter(name => name !== "tmp" && name !== "file-owners")).toEqual([]);
});

it("returns the same refusal through session, token, MCP and the assistant tool outcome", async () => {
  const { POST } = await import("@/app/api/imports/url/route");
  const { getAccount } = await import("@/lib/metadata/accounts");
  const { issueSession, authenticateSession, createApiToken } = await import("@/lib/auth/credentials");
  const { socketRequest } = await import("@/lib/assistant/testing/socket-request");
  const { authenticatedRoute } = await import("@/lib/assistant/testing/account");
  const { testClient } = await import("@/lib/mcp/test-client");
  const { buildTools } = await import("@/lib/tools/tools");
  const { executeTool } = await import("@/lib/tools/execute");
  const { actionOutcome, actionEffects } = await import("@/lib/assistant/action-metadata");
  const scope = testAccountScope(); const db = metadataDb();
  const session = issueSession(getAccount(scope.accountId)!, db, Date.now());
  const token = createApiToken(authenticateSession(session.secret, db)!, "Storage proof", db);
  volume.free = 0;
  const args = { url: "https://example.test/data.csv" };
  const credentials: Record<string, string>[] = [{ cookie: `dezfil_session=${session.secret}`, origin: "http://instance.test" }, { authorization: `Bearer ${token.secret}` }];
  for (const headers of credentials) {
    const response = await POST(socketRequest(new Request("http://instance.test/api/imports/url", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(args) })));
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("storage_full");
  }
  const route = authenticatedRoute(POST);
  const client = await testClient(route);
  try {
    const result = await client.callTool({ name: "import_table_from_url", arguments: args });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("storage_full");
    const tool = buildTools().find(tool => tool.name === "import_table_from_url")!;
    const outcome = await executeTool(tool, args, "http://instance.test", async (input, init) => route(new Request(input, init)));
    expect(outcome.status).toBe(409);
    expect(actionOutcome(outcome, actionEffects(tool, args)).outcome).toBe("refused");
  } finally { await client.close(); vi.unstubAllGlobals(); }
});
