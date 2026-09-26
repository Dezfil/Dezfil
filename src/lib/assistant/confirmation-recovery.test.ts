import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createRecipe, addStep, reorderSteps } from "@/lib/metadata/recipes";
import { listCascades } from "@/lib/metadata/cascades";
import { assistantRuns } from "./runs";
import { requiresRefresh } from "@/components/builder/assistant/assistant-event-metadata";
import { pendingActions } from "./pending";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import type { ModelProvider } from "./provider";
import type { AssistantEvent } from "./loop";
import { POST as reserve } from "@/app/api/assistant/runs/route";
import { POST as message } from "@/app/api/assistant/messages/route";
import { GET as recovery } from "@/app/api/assistant/runs/[id]/route";
import { GET as pending } from "@/app/api/assistant/pending/route";
import { POST as mapsPost } from "@/app/api/maps/route";
import * as mapRoute from "@/app/api/maps/[id]/route";
import { GET as dependencies } from "@/app/api/maps/[id]/dependencies/route";
import * as publishRoute from "@/app/api/maps/[id]/publish/route";
import { POST as undo } from "@/app/api/maps/[id]/undo/route";
import { POST as redo } from "@/app/api/maps/[id]/redo/route";
import { GET as catalogue } from "@/app/api/catalogue/tables/route";
import { GET as recipeGet } from "@/app/api/recipes/[id]/route";
import { POST as runRecipe } from "@/app/api/recipes/[id]/runs/route";
import { POST as query } from "@/app/api/query/route";

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
const origin = "http://localhost:3201";
let dir: string;
let failPlan = false;
let failMapAfterWrite = false;
const calls: { path: string; method: string; body: unknown }[] = [];
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url); const p = url.pathname.split("/");
  calls.push({ path: url.pathname, method: request.method, body: request.method === "GET" ? null : await request.clone().json().catch(() => null) });
  if (url.pathname === "/api/catalogue/tables") return catalogue(request);
  if (url.pathname === "/api/query") return query(request);
  if (url.pathname === "/api/maps") return mapsPost(request);
  if (p[2] === "maps") {
    if (p.length === 4) {
      const response = await mapRoute[request.method as "GET" | "PATCH" | "DELETE"](request, params(p[3]));
      return failMapAfterWrite && request.method === "PATCH"
        ? Response.json({ error: { code: "internal" } }, { status: 500 }) : response;
    }
    if (p[4] === "dependencies") return dependencies(request, params(p[3]));
    if (p[4] === "publish") return publishRoute[request.method as "POST" | "DELETE"](request, params(p[3]));
    if (p[4] === "undo") return undo(request, params(p[3]));
    if (p[4] === "redo") return redo(request, params(p[3]));
  }
  if (p[2] === "recipes" && p.length === 4) return recipeGet(request, params(p[3]));
  if (p[2] === "recipes" && p[4] === "runs") return failPlan ? Response.json({ error: { code: "internal" } }, { status: 500 }) : runRecipe(request, params(p[3]));
  throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
}
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-confirm-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests(); calls.length = 0; failPlan = false; failMapAfterWrite = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatch(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
const tool = (name: string, args: Record<string, unknown>) => ({ id: randomUUID(), name, args });
const reply = (...toolCalls: ReturnType<typeof tool>[]) => ({ text: "", toolCalls });
async function events(response: Response): Promise<AssistantEvent[]> { expect(response.status).toBe(200); return (await response.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
async function start(script: ScriptEntry[], extra = {}) {
  const provider = stubProvider(script); factory.provider = provider;
  const id = (await (await reserve()).json()).id as string;
  const body = { runId: id, message: "Work", ...extra };
  await events(await message(req("/api/assistant/messages", body)));
  return { id, body, provider };
}
async function open(id: string) { return (await (await pending()).json()).pending.find((p: { runId: string }) => p.runId === id); }
async function read(id: string) { return (await (await recovery(req(`/api/assistant/runs/${id}`), params(id))).json()); }
async function resolve(id: string, approved = true, extra = {}) {
  const action = await open(id); expect(action).toBeDefined();
  return { action, response: await message(req("/api/assistant/messages", { resolution: { pending: action.id, approved }, ...extra })) };
}
async function seedMap(name = "Original") { return (await (await mapsPost(req("/api/maps", { name }))).json()).id as string; }
async function map(id: string) { return (await (await mapRoute.GET(req(`/api/maps/${id}`), params(id))).json()); }

for (const approved of [true, false]) it(`recovery ${approved ? "approval" : "decline"} binds original target and repeat executes nothing`, async () => {
  const first = await seedMap("Duplicate name"); const other = await seedMap("Duplicate name");
  const { id, provider } = await start([reply(tool("publish_map", { id: first })), reply()], { context: { page: "builder", mapId: first, selectedLayerId: null } });
  const parked = await open(id);
  expect(parked.confirmation).toEqual({ target: `Publish Duplicate name (${first})?`, consequence: "Anyone with the link can view its published data." });
  expect(parked.args).toEqual({ id: first });
  const { response } = await resolve(id, approved, { context: { page: "builder", mapId: other, selectedLayerId: null } });
  await response.text(); // Simulated lost approval response, recovered by GET.
  const receipt = await read(id); expect(receipt.state).toBe("completed");
  expect(Boolean((await map(first)).publishToken)).toBe(approved);
  expect((await map(other)).publishToken).toBeNull();
  const result = receipt.actions[0];
  if (approved) expect(result).toMatchObject({ tool: "publish_map", status: "succeeded", effects: { writes: [expect.objectContaining({ resource: "publications", ids: expect.arrayContaining([first]) })] } });
  else { expect(result).toMatchObject({ tool: "publish_map", status: "refused", args: { id: first } }); expect(calls.filter((c) => c.path.endsWith("/publish"))).toHaveLength(0); }
  const repeated = await message(req("/api/assistant/messages", { resolution: { pending: parked.id, approved: true } }));
  expect(repeated.status).toBe(409); expect((await repeated.json()).error.code).toBe("pending_resolved");
  expect(provider.recording.exchanges).toHaveLength(1);
  expect(JSON.parse(provider.recording.exchanges[0].groundings[1]!).context.mapId).toBe(first);
});

it("conflicting supersession cannot abandon a pending action, while a new reserved turn can", async () => {
  const mapId = await seedMap();
  const parked = await start([reply(tool("publish_map", { id: mapId })), reply()]);
  const prior = await start([reply()]);
  const action = await open(parked.id);
  const conflict = await message(req("/api/assistant/messages", { ...prior.body, supersedes: action.id }));
  expect(conflict.status).toBe(409); expect((await open(parked.id)).id).toBe(action.id);
  await start([reply()], { supersedes: action.id });
  expect(await open(parked.id)).toBeUndefined(); expect((await read(parked.id)).state).toBe("interrupted");
  const old = await message(req("/api/assistant/messages", { resolution: { pending: action.id, approved: true } }));
  expect((await old.json()).error.code).toBe("pending_superseded"); expect((await map(mapId)).publishToken).toBeNull();
});

for (const interleaved of [false, true]) it(`undo and redo preserve two confirmation pauses ${interleaved ? "with" : "without"} a manual edit`, async () => {
  const mapId = await seedMap();
  const { id, provider } = await start([
    reply(tool("update_map", { id: mapId, name: "Before pause" }), tool("publish_map", { id: mapId })),
    reply(tool("update_map", { id: mapId, name: "Between pauses" }), tool("unpublish_map", { id: mapId })),
    reply(tool("update_map", { id: mapId, name: "After pauses" })), reply(),
  ]);
  expect((await map(mapId)).name).toBe("Before pause");
  if (interleaved) await dispatch(req(`/api/maps/${mapId}`, { name: "Manual edit" }, "PATCH"));
  const first = await resolve(id); await events(first.response);
  expect((await map(mapId)).name).toBe("Between pauses");
  const second = await resolve(id); expect(second.action.id).not.toBe(first.action.id); await events(second.response);
  expect((await map(mapId)).name).toBe("After pauses"); expect((await read(id)).state).toBe("completed");
  expect(provider.recording.exchanges).toHaveLength(1);
  const undoNames = interleaved ? ["Manual edit", "Before pause", "Original"] : ["Original"];
  for (const name of undoNames) { await dispatch(req(`/api/maps/${mapId}/undo`, {})); expect((await map(mapId)).name).toBe(name); }
  const redoNames = interleaved ? ["Before pause", "Manual edit", "After pauses"] : ["After pauses"];
  for (const name of redoNames) { await dispatch(req(`/api/maps/${mapId}/redo`, {})); expect((await map(mapId)).name).toBe(name); }
});

it("the whole-turn budget spans two recovered pauses", async () => {
  vi.stubEnv("DEZFIL_ASSISTANT_STEP_BUDGET", "3");
  const mapId = await seedMap();
  const { id, provider } = await start([
    reply(tool("update_map", { id: mapId, name: "First" }), tool("publish_map", { id: mapId }), tool("unpublish_map", { id: mapId }), tool("update_map", { id: mapId, name: "Forbidden fourth" })),
  ]);
  await events((await resolve(id)).response);
  expect(await read(id)).toMatchObject({ state: "awaiting_confirmation" });
  expect((await events((await resolve(id)).response)).at(-1)).toEqual({ type: "done", reason: "budget" });
  expect((await map(mapId)).name).toBe("First"); expect((await read(id)).actions).toHaveLength(3);
  expect(provider.recording.exchanges[0].outcomes).toHaveLength(0);
});

for (const change of ["membership", "order", "unavailable"] as const) it(`a ${change} recipe plan never starts an unspecified or changed wide run`, async () => {
  const recipe = createRecipe("Workflow");
  const first = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS v", name: "one" } });
  const second = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 2 AS v", name: "two" } });
  failPlan = change === "unavailable";
  const { id } = await start([reply(tool("run_recipe", { id: recipe.id, members: ["model-supplied-wrong-member"] })), reply()]);
  if (change === "unavailable") {
    expect(await open(id)).toBeUndefined(); expect((await read(id)).error.code).toBe("assistant_plan_unavailable");
  } else {
    expect((await open(id)).args.members).toEqual([first.id, second.id]);
    if (change === "membership") addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 3 AS v", name: "three" } });
    else reorderSteps(recipe.id, [second.id, first.id]);
    const resumed = await events((await resolve(id)).response);
    expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", ok: false, outcome: "refused", body: { error: expect.objectContaining({ code: "plan_changed" }) } }));
  }
  expect(listCascades(recipe.id)).toHaveLength(0);
});

it("real read-only POST and conditional plan events declare no mutation", async () => {
  const recipe = createRecipe("Plan"); addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS v", name: "one" } });
  const { id } = await start([reply(tool("run_sql", { sql: "SELECT 7 AS value" }), tool("run_recipe", { id: recipe.id, plan: true })), reply()]);
  const actions = (await read(id)).actions;
  expect(actions).toHaveLength(2);
  for (const action of actions) expect(action).toMatchObject({ status: "succeeded", effects: { readOnly: true, writes: [] } });
  expect(listCascades(recipe.id)).toHaveLength(0);
});

it("a mutation returning 500 after its write stays uncertain and reconciles the builder", async () => {
  const mapId = await seedMap();
  failMapAfterWrite = true;
  const { id } = await start([reply(tool("update_map", { id: mapId, name: "Written before 500" })), reply()]);
  const receipt = await read(id);
  expect((await map(mapId)).name).toBe("Written before 500");
  expect(receipt.actions).toEqual([expect.objectContaining({ tool: "update_map", status: "uncertain",
    effects: { readOnly: false, writes: [expect.objectContaining({ resource: "maps", ids: [mapId] })] } })]);
  expect(requiresRefresh(receipt.actions)).toBe(true);
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
});
