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
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { normalizeStyle } from "@/lib/style/style";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { GET } from "./route";
import { DELETE } from "../route";

/**
 * The readers read over HTTP and through its generated tool, against
 * answers written out by hand. Ada's `roads` is read by two layers of her
 * published map, a hidden layer of a draft, a workflow step that never ran,
 * a step through a saved pending edit, and a layer of Bob's private map,
 * which she cannot open; Bob is an Editor of the project both her tables
 * are filed in. Her `parks` is read only by Bob's map; her `rivers` by
 * nothing.
 */

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let roads: string;
let ordinal = 0;

function layered(owner: string, name: string, layers: [name: string, sql: string, visible?: boolean][]): string {
  const id = createMap(scopes[owner], name).id;
  for (const [layer, sql, visible = true] of layers) {
    insertLayer({ id: `${name}/${layer}`, mapId: id, name: layer, sql, style: normalizeStyle({}), visible, tooltip: null, popup: null,
      publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
      ordinal: ordinal++, createdAt: "time", updatedAt: "time" });
  }
  return id;
}

function stepped(owner: string, name: string, parameters: Record<string, unknown>, proposed?: Record<string, unknown>): { id: string; step: string } {
  const recipe = createRecipe(scopes[owner], name, metadataDb(), "workflow");
  const step = addStep(recipe.id, { operation: "sql_step", parameters }).id;
  if (proposed) metadataDb().prepare("UPDATE recipe_steps SET proposed_parameters = ? WHERE id = ?").run(JSON.stringify(proposed), step);
  return { id: recipe.id, step };
}

async function ingest(name: string, rows: number): Promise<string> {
  const file = path.join(directory, `${name}.csv`);
  await writeFile(file, `id,lon,lat\n${Array.from({ length: rows }, (_, i) => `${i},1,2`).join("\n")}\n`);
  await ingestFile(scopes.ada, file, `${name}.csv`);
  return (metadataDb().prepare("SELECT id FROM data_tables WHERE owner_id = 'ada' AND name = ?").get(name) as { id: string }).id;
}

/** The same question through the generated tool, as Ada. */
async function viaTool(address: string) {
  const tool = buildTools().find((candidate) => candidate.name === "list_table_readers")!;
  return executeTool(tool, { name: address }, "http://localhost", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = testAccountRequest(new Request(String(input), init), undefined, "ada");
    const name = decodeURIComponent(new URL(request.url).pathname.split("/")[3]);
    return GET(request, { params: Promise.resolve({ name }) });
  }) as typeof fetch);
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
  roads = await ingest("roads", 2);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it("answers the written-down fixture over HTTP and through its tool, and refuses everyone else", async () => {
  const parks = await ingest("parks", 4);
  const rivers = await ingest("rivers", 1);
  shareProject("ada", "P", [["bob", "editor"]], [roads, parks]);
  const published = layered("ada", "Collisions 2025", [["Collisions", "SELECT * FROM roads"], ["Hotspots", "SELECT count(*) FROM roads"]]);
  metadataDb().prepare("UPDATE maps SET publish_token = 'token', published_at = 'time' WHERE id = ?").run(published);
  const draft = layered("ada", "Draft", [["Hidden", "SELECT * FROM roads", false]]);
  const never = stepped("ada", "Flow", { sql: "SELECT * FROM roads", name: "flow_out" });
  const pending = stepped("ada", "Pending", { sql: "SELECT 1 AS x", name: "pending_out" }, { sql: "SELECT * FROM roads", name: "pending_out" });
  layered("bob", "Bob's private", [["Theirs", "SELECT * FROM ada.roads"], ["Parks", "SELECT * FROM ada.parks"]]);

  const sqlStep = (workflow: { id: string; step: string }, name: string) =>
    ({ kind: "step", workflow: { id: workflow.id, name }, step: { id: workflow.step, position: 1, operation: "sql_step", label: "SQL step" } });
  const answers = {
    roads: {
      table: { id: roads, name: "roads", rowCount: 2 },
      readers: [
        { kind: "layer", map: { id: published, name: "Collisions 2025", published: true }, layer: { id: "Collisions 2025/Collisions", name: "Collisions" } },
        { kind: "layer", map: { id: published, name: "Collisions 2025", published: true }, layer: { id: "Collisions 2025/Hotspots", name: "Hotspots" } },
        { kind: "layer", map: { id: draft, name: "Draft", published: false }, layer: { id: "Draft/Hidden", name: "Hidden" } },
        sqlStep(never, "Flow"),
        sqlStep(pending, "Pending"),
      ],
      unlisted: 1,
    },
    parks: { table: { id: parks, name: "parks", rowCount: 4 }, readers: [], unlisted: 1 },
    rivers: { table: { id: rivers, name: "rivers", rowCount: 1 }, readers: [], unlisted: 0 },
  };

  for (const [name, expected] of Object.entries(answers)) {
    expect(await call("ada", name)).toEqual({ status: 200, body: expected });
    expect(await call("ada", expected.table.id)).toEqual({ status: 200, body: expected });
    const result = await viaTool(name);
    expect(result).toMatchObject({ status: 200, ok: true });
    expect(result.body).toEqual(expected);
    expect(JSON.stringify(result.body)).not.toMatch(/Bob|Theirs/);
  }

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
