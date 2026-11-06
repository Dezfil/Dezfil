import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { ingestFile } from "@/lib/ingest/ingest";
import type { AccountScope } from "@/lib/auth/scope";
import { createMap } from "@/lib/map-service";
import { insertLayer } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { GET } from "./route";
import { DELETE } from "../route";

/**
 * The readers read over HTTP and through its generated tool, against an
 * answer written out by hand: Ada's `roads` is read by her published map
 * and by Bob's private one, which she cannot open.
 */

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let roads: string;

function layered(owner: string, name: string, sql: string): string {
  const id = createMap(scopes[owner], name).id;
  insertLayer({ id: `${name}/layer`, mapId: id, name: "Collisions", sql, style: normalizeStyle({}), visible: true, tooltip: null, popup: null,
    publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
    ordinal: 0, createdAt: "time", updatedAt: "time" });
  return id;
}

async function call(account: string, address: string) {
  const request = testAccountRequest(new Request(`http://localhost/api/tables/${encodeURIComponent(address)}/readers`), undefined, account);
  const response = await GET(request, { params: Promise.resolve({ name: address }) });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "table-readers-route-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "id,lon,lat\n1,1,2\n2,3,4\n");
  await ingestFile(scopes.ada, file, "roads.csv");
  roads = (metadataDb().prepare("SELECT id FROM data_tables WHERE owner_id = 'ada' AND name = 'roads'").get() as { id: string }).id;
  shareProject("ada", "P", [["bob", "editor"]], [roads]);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it("answers the owner, refuses the rest, and agrees with its generated tool", async () => {
  const mine = layered("ada", "Collisions 2025", "SELECT * FROM roads");
  metadataDb().prepare("UPDATE maps SET publish_token = 'token', published_at = 'time' WHERE id = ?").run(mine);
  layered("bob", "Bob's private", "SELECT * FROM ada.roads");
  const expected = {
    table: { id: roads, name: "roads", rowCount: 2 },
    readers: [{ kind: "layer", map: { id: mine, name: "Collisions 2025", published: true }, layer: { id: "Collisions 2025/layer", name: "Collisions" } }],
    unlisted: 1,
  };

  expect(await call("ada", "roads")).toEqual({ status: 200, body: expected });
  expect(await call("ada", roads)).toEqual({ status: 200, body: expected });
  expect((await call("bob", "ada.roads")).status).toBe(403);
  expect((await call("bob", roads)).status).toBe(403);
  const unreached = await call("cyd", "ada.roads");
  const missing = await call("cyd", "ada.nothing");
  expect(unreached.status).toBe(404);
  expect(unreached).toEqual(missing);

  const tool = buildTools().find((candidate) => candidate.name === "list_table_readers")!;
  expect(tool.path).toBe("/api/tables/{name}/readers");
  expect(tool.confirm).toBe(false);
  expect(tool.mcp).toEqual({ destructiveHint: false, openWorldHint: false, idempotentHint: true });
  const result = await executeTool(tool, { name: "roads" }, "http://localhost", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = testAccountRequest(new Request(String(input), init), undefined, "ada");
    const name = decodeURIComponent(new URL(request.url).pathname.split("/")[3]);
    return GET(request, { params: Promise.resolve({ name }) });
  }) as typeof fetch);
  expect(result).toMatchObject({ status: 200, ok: true, body: expected });
  expect(JSON.stringify(result.body)).not.toMatch(/Bob/);
});

it("addresses the table it was opened for: a same-named replacement is neither checked nor deleted by the old identifier", async () => {
  const old = roads;
  const removal = (address: string) => DELETE(
    testAccountRequest(new Request(`http://localhost/api/tables/${encodeURIComponent(address)}`, { method: "DELETE" }), undefined, "ada"),
    { params: Promise.resolve({ name: address }) },
  );
  expect((await removal(old)).status).toBe(204);
  const file = path.join(directory, "roads-again.csv");
  await writeFile(file, "id,lon,lat\n1,1,2\n");
  await ingestFile(scopes.ada, file, "roads.csv");
  const replacement = (metadataDb().prepare("SELECT id FROM data_tables WHERE owner_id = 'ada' AND name = 'roads'").get() as { id: string }).id;
  expect(replacement).not.toBe(old);

  expect((await call("ada", old)).status).toBe(404);
  expect((await removal(old)).status).toBe(404);
  expect(metadataDb().prepare("SELECT id FROM data_tables WHERE id = ?").get(replacement)).toEqual({ id: replacement });
  expect((await call("ada", "roads")).body.table).toEqual({ id: replacement, name: "roads", rowCount: 1 });
});
