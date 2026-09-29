import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { assistantRuns } from "@/lib/assistant/runs";
import { POST as reserveRunHandler } from "@/app/api/assistant/runs/route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { createCascade, setMember, finishCascade } from "@/lib/metadata/cascades";
import type { AssistantContext } from "./context";
import type { ModelProvider } from "./provider";
import { stubProvider } from "./providers/stub";
import { pendingActions } from "./pending";
import { POST as POSTHandler } from "@/app/api/assistant/messages/route";
import { GET as catalogueGet } from "@/app/api/catalogue/tables/route";
import { GET as mapGet } from "@/app/api/maps/[id]/route";
import { GET as dependenciesGet } from "@/app/api/maps/[id]/dependencies/route";
import { GET as recipeGet } from "@/app/api/recipes/[id]/route";
import { GET as runGet } from "@/app/api/recipes/[id]/runs/[runId]/route";

const reserveRun = authenticatedRoute(reserveRunHandler);
const POST = authenticatedRoute(POSTHandler);

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null, calls: 0 }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => { factory.calls++; return factory.provider; } }));
let dir: string;
let contexts: string[];
async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  contexts.push(url.pathname);
  const p = url.pathname.split("/").map(decodeURIComponent);
  if (url.pathname === "/api/catalogue/tables") return catalogueGet(testAccountRequest(request));
  if (p[2] === "maps" && p.length === 4) return mapGet(testAccountRequest(request), { params: Promise.resolve({ id: p[3] }) });
  if (p[2] === "maps" && p[4] === "dependencies") return dependenciesGet(testAccountRequest(request), { params: Promise.resolve({ id: p[3] }) });
  if (p[2] === "recipes" && p.length === 4) return recipeGet(testAccountRequest(request), { params: Promise.resolve({ id: p[3] }) });
  if (p[2] === "recipes" && p[4] === "runs") return runGet(testAccountRequest(request), { params: Promise.resolve({ id: p[3], runId: p[5] }) });
  throw new Error(`Unexpected test API call: ${request.method} ${url.pathname}`);
}
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-grounding-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  closeMetadataDb(); resetQueryInstance(); contexts = []; factory.calls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => dispatch(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function post(body: unknown) {
  if (body && typeof body === "object" && "message" in body && !("resolution" in body)) {
    const reservation = await reserveRun();
    body = { ...body, runId: (await reservation.json()).id };
  }
  return POST(new Request("http://localhost:3201/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
async function send(context?: AssistantContext) {
  const provider = stubProvider([{ text: "Captured", toolCalls: [] }]); factory.provider = provider;
  const response = await post({ message: "Explain this", context });
  expect(response.status).toBe(200); await response.text();
  return JSON.parse(provider.recording.exchanges[0].groundings[0]!);
}
async function seedMap() {
  const csv = path.join(dir, "facts.csv"); await writeFile(csv, "city,lon,lat,value\nBerlin,13.4,52.5,4\n");
  await ingestFile(testAccountScope(), csv, "facts.csv");
  const map = createMap(testAccountScope(), "Original map");
  const layer = await createLayer(testAccountScope(), map.id, { name: "Chosen layer", sql: "SELECT * FROM facts" });
  return { map, layer, context: { page: "builder", mapId: map.id, selectedLayerId: layer.id } as const };
}

describe("grounding through real message and resource routes", () => {
  it("captures the selected map/layer and current table schema on successive turns", async () => {
    const { map, layer, context } = await seedMap();
    const first = await send(context);
    expect(first.context).toEqual(context);
    expect(first.map).toMatchObject({ id: map.id, name: "Original map", layers: { items: [{ id: layer.id, name: "Chosen layer", sql: "SELECT * FROM facts" }] } });
    expect(first.catalogue.items[0]).toMatchObject({ name: "facts", rowCount: 1, geometryColumn: "geometry", geometryType: "POINT" });
    expect(first.catalogue.items[0].columns.map((column: { name: string }) => column.name)).toContain("value");
    await updateMap(testAccountScope(), map.id, { name: "Changed map" });
    await updateLayer(testAccountScope(), layer.id, { name: "Changed layer", visible: false });
    const nextCsv = path.join(dir, "new.csv"); await writeFile(nextCsv, "new_column\ncurrent\n"); await ingestFile(testAccountScope(), nextCsv, "new.csv");
    const second = await send(context);
    expect(second.map).toMatchObject({ name: "Changed map", layers: { items: [{ name: "Changed layer", visible: false }] } });
    expect(second.catalogue.items.find((table: { name: string }) => table.name === "new").columns).toEqual([{ name: "new_column", type: "VARCHAR" }]);
  });
  it("refreshes on confirmation continuation while retaining original context and pending arguments", async () => {
    const { map, layer, context } = await seedMap();
    const provider = stubProvider([
      { text: "Ready", toolCalls: [{ id: "fresh-pending-call", name: "delete_layer", args: { id: layer.id } }] },
      { text: "Declined", toolCalls: [] },
    ]); factory.provider = provider;
    const initial = await post({ message: "Delete this layer", context });
    const events = (await initial.text()).trim().split("\n").map((line) => JSON.parse(line));
    const pending = events.find((event) => event.type === "confirm_required").id;
    expect(pendingActions.peek(pending)?.calls[0].args).toEqual({ id: layer.id });
    await updateMap(testAccountScope(), map.id, { name: "Name changed while pending" });
    await updateLayer(testAccountScope(), layer.id, { visible: false });
    const csv = path.join(dir, "later.csv"); await writeFile(csv, "later_column\n9\n"); await ingestFile(testAccountScope(), csv, "later.csv");
    const response = await post({ resolution: { pending, approved: false } });
    expect(response.status).toBe(200); await response.text();
    expect(provider.recording.exchanges).toHaveLength(1);
    const second = JSON.parse(provider.recording.exchanges[0].groundings[1]!);
    expect(second.context).toEqual(context);
    expect(second.map.name).toBe("Name changed while pending");
    expect(second.map.layers.items[0]).toMatchObject({ id: layer.id, visible: false });
    expect(second.catalogue.items.find((table: { name: string }) => table.name === "later").columns[0].name).toBe("later_column");
    expect(factory.calls).toBe(1);
  });
  it("captures SQL success, error, no-execution and selection independently of draft", async () => {
    for (const lastExecution of [null,
      { sql: " SELECT 4;\n", result: { totalRows: 10, returnedRows: 2, truncated: true, columns: [{ name: "v", type: "INTEGER" }], elapsedMs: 1.5 } },
      { sql: " SELECT absent;\n", error: { code: "sql_error", message: "Missing column" } },
    ]) for (const selection of [null, "SELECT 'draft'"]) {
      const context: AssistantContext = { page: "sql", draft: "SELECT 'draft';\n", selection, lastExecution };
      expect((await send(context)).context).toEqual(context);
    }
    const noContext = await send(); expect(noContext.context).toBeNull(); expect(noContext.map).toBeUndefined(); expect(noContext.recipe).toBeUndefined();
  });
  it("captures active/proposed workflow definitions and a failed member with a cancelled attempt", async () => {
    const recipe = createRecipe(testAccountScope(), "Workflow");
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "output" } });
    metadataDb().prepare("UPDATE recipe_steps SET proposed_parameters = ? WHERE id = ?").run(JSON.stringify({ sql: "SELECT 2 AS value", name: "output" }), step.id);
    const run = createCascade(recipe.id, "run_all", [{ stepId: step.id, ordinal: 0, operation: "sql_step", name: "Node" }]);
    setMember(run.id, step.id, { state: "failed", stoppedBy: "cancelled", stoppedReason: "The user cancelled the run." });
    metadataDb().prepare("UPDATE cascade_members SET attempt_state = 'cancelled', attempt_accepted_at = ? WHERE cascade_id = ?").run("2026-09-15T00:00:00Z", run.id);
    finishCascade(run.id, "cancelled", "2026-09-15T00:01:00Z");
    const context: AssistantContext = { page: "workflow", recipeId: recipe.id, selectedStepId: step.id, lastRunId: run.id };
    const result = await send(context);
    expect(result.context).toEqual(context);
    expect(result.recipe.steps.items[0]).toMatchObject({ id: step.id, parameters: { sql: "SELECT 1 AS value" }, proposedParameters: { sql: "SELECT 2 AS value" } });
    expect(result.run).toMatchObject({ outcome: "cancelled", members: { items: [{ state: "failed", stoppedBy: "cancelled", stoppedReason: "The user cancelled the run.", attempt: { state: "cancelled" } }] } });
  });
  it("refuses missing, wrong-parent, malformed, oversized and preview context before provider work", async () => {
    const { context } = await seedMap();
    const otherMap = createMap(testAccountScope(), "Other");
    const recipe = createRecipe(testAccountScope(), "First"); const otherRecipe = createRecipe(testAccountScope(), "Other");
    const step = addStep(otherRecipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "output" } });
    const run = createCascade(otherRecipe.id, "run_all", [{ stepId: step.id, ordinal: 0 }]);
    for (const bad of [
      { ...context, mapId: "missing" }, { ...context, mapId: otherMap.id }, { ...context, selectedLayerId: "missing" },
      { page: "workflow", recipeId: recipe.id, selectedStepId: step.id, lastRunId: null },
      { page: "workflow", recipeId: recipe.id, selectedStepId: null, lastRunId: run.id },
      { page: "sql" }, { page: "sql", draft: "x".repeat(65_536), selection: null, lastExecution: null },
      { page: "sql", draft: "x", selection: null, lastExecution: { preview: [] } },
    ]) {
      const before = factory.calls;
      const response = await post({ message: "Explain", context: bad });
      expect([400, 413]).toContain(response.status);
      expect((await response.json()).error.code).toMatch(/^assistant_context_/);
      expect(factory.calls).toBe(before);
    }
    expect(contexts.some((url) => url.includes("/query"))).toBe(false);
  });
});
