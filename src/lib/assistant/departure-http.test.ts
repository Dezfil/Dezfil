import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { cascadeSettled, readCascade } from "@/lib/operations/cascade";
import { GET as recipeGet } from "@/app/api/recipes/[id]/route";
import { POST as recipeRun } from "@/app/api/recipes/[id]/runs/route";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter, signalFromNodeResponse } from "next/dist/server/web/spec-extension/adapters/next-request";
import { pipeToNodeResponse } from "next/dist/server/pipe-readable";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import type { ModelProvider } from "./provider";
import { stubProvider } from "./providers/stub";
import { openaiProvider } from "./providers/openai";
import { anthropicProvider } from "./providers/anthropic";
import { anthropicEvents } from "./testing/wire";
import { POST as send } from "@/app/api/assistant/messages/route";
import { POST as reserve } from "@/app/api/assistant/runs/route";
import { GET as recover } from "@/app/api/assistant/runs/[id]/route";
import { POST as cancel } from "@/app/api/assistant/runs/[id]/cancel/route";
import { GET as catalogue } from "@/app/api/catalogue/tables/route";
import { GET as mapsGet, POST as mapsPost } from "@/app/api/maps/route";
import { GET as mapGet } from "@/app/api/maps/[id]/route";
import { POST as query } from "@/app/api/query/route";

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
let server: Server; let origin: string; let dir: string;
let beforeMutation: (() => Promise<void>) | undefined;
let loseMutation = false;
let queryStatus: number | undefined;
let mutations = 0;
let querySettled = deferred();
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-http-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  beforeMutation = undefined; loseMutation = false; queryStatus = undefined; mutations = 0; querySettled = deferred();
  // A real TCP listener with Next's actual request-signal and response-pipe
  // adapters, invoking the shipped handlers. No synthetic request abort.
  server = createServer(async (incoming, outgoing) => {
    incoming.url = origin + incoming.url;
    const request = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), signalFromNodeResponse(outgoing));
    const url = new URL(request.url); const p = url.pathname.split("/");
    let response: Response;
    try {
      if (url.pathname === "/api/assistant/messages") response = await send(request);
      else if (url.pathname === "/api/assistant/runs") response = await reserve();
      else if (p[2] === "assistant" && p[3] === "runs") response = p[5] === "cancel" ? await cancel(request, params(p[4])) : await recover(request, params(p[4]));
      else if (url.pathname === "/api/catalogue/tables") response = await catalogue(request);
      else if (url.pathname === "/api/maps" && request.method === "POST") {
        mutations++; await beforeMutation?.(); response = await mapsPost(request);
        if (loseMutation) { outgoing.destroy(); return; }
      } else if (url.pathname === "/api/maps") response = await mapsGet(request);
      else if (p[2] === "maps") response = await mapGet(request, params(p[3]));
      else if (p[2] === "recipes" && p[4] === "runs") response = await recipeRun(request, params(p[3]));
      else if (p[2] === "recipes") response = await recipeGet(request, params(p[3]));
      else if (url.pathname === "/api/query") { response = await query(request); queryStatus = response.status; querySettled.resolve(); }
      else response = new Response(null, { status: 404 });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      if (response.body) await pipeToNodeResponse(response.body, outgoing); else outgoing.end();
    } catch (error) { outgoing.destroy(error instanceof Error ? error : undefined); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
  expect(address.port).not.toBe(3000); origin = `http://127.0.0.1:${address.port}`; vi.stubEnv("PORT", String(address.port));
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
});
const post = (url: string, body: unknown, signal?: AbortSignal) => fetch(origin + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
async function reserveId() { return (await (await post("/api/assistant/runs", {})).json()).id as string; }
async function receipt(id: string) { return (await (await fetch(`${origin}/api/assistant/runs/${id}`)).json()); }
async function interrupted(id: string) { await expect.poll(async () => (await receipt(id)).state, { timeout: 5000 }).toBe("interrupted"); }

for (const vendor of ["openai", "anthropic"] as const) it(`${vendor}: actual assistant HTTP departure cancels held provider generation`, async () => {
  const entered = deferred(); const aborted = deferred(); let requests = 0;
  const wire: typeof fetch = async (_input, init) => {
    requests++;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const events = vendor === "openai" ? [{ type: "response.output_text.delta", delta: "Partial", item_id: "message", output_index: 0, content_index: 0, sequence_number: 0 }] : [anthropicEvents([])[0], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } }];
      for (const event of events) controller.enqueue(new TextEncoder().encode(`${vendor === "anthropic" ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`));
      init!.signal!.addEventListener("abort", () => { aborted.resolve(); controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
      entered.resolve();
    } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  factory.provider = vendor === "openai" ? openaiProvider("fixture", "gpt-6-astra", wire) : anthropicProvider("fixture", "claude-opus-5", wire);
  const id = await reserveId(); const controller = new AbortController();
  const response = await post("/api/assistant/messages", { runId: id, message: "Work" }, controller.signal);
  await entered.promise;
  const first = await response.body!.getReader().read(); expect(new TextDecoder().decode(first.value)).toContain("Partial");
  controller.abort(); await aborted.promise; await interrupted(id);
  expect((await receipt(id)).text).toBe("Partial"); expect(requests).toBe(1); expect(mutations).toBe(0);
});

it("real HTTP departure interrupts unfinished DuckDB SQL before its independent timeout", async () => {
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "30");
  const entered = deferred(); let finished = false;
  const original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, ...args) {
    const result = original.apply(this, args);
    if (String(args[0]).startsWith("SELECT count(*)") && String(args[0]).includes("1000000000")) {
      entered.resolve(); void result.then(() => { finished = true; }, () => { finished = true; });
    }
    return result;
  });
  factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "query", name: "run_sql", args: { sql: "SELECT * FROM range(1000000000) WHERE range % 7 < 6" } }, { id: "forbidden", name: "create_map", args: { name: "No" } }] }]);
  const id = await reserveId(); const controller = new AbortController();
  const response = await post("/api/assistant/messages", { runId: id, message: "Evaluate" }, controller.signal);
  await entered.promise; expect(finished).toBe(false);
  const started = Date.now(); controller.abort(); await querySettled.promise;
  expect(queryStatus).toBe(499); expect(Date.now() - started).toBeLessThan(5000); expect(finished).toBe(true);
  await interrupted(id); expect(mutations).toBe(0); void response;
}, 15_000);

it("a dispatched mutation settles after outer disconnect and admits no next step", async () => {
  const entered = deferred(); const release = deferred(); beforeMutation = async () => { entered.resolve(); await release.promise; };
  factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "once", name: "create_map", args: { name: "Settled map" } }, { id: "never", name: "create_map", args: { name: "Forbidden map" } }] }]);
  const id = await reserveId(); const controller = new AbortController();
  const response = await post("/api/assistant/messages", { runId: id, message: "Create" }, controller.signal);
  await entered.promise; controller.abort();
  await expect.poll(() => assistantRuns.signal(id).aborted).toBe(true);
  expect((await receipt(id)).state).toBe("running"); release.resolve(); await interrupted(id);
  const maps = await (await fetch(origin + "/api/maps")).json(); expect(maps).toHaveLength(1); expect(maps[0].name).toBe("Settled map");
  expect((await receipt(id)).actions).toEqual([expect.objectContaining({ id: "once", status: "succeeded", effects: { readOnly: false, writes: [{ resource: "maps", ids: [maps[0].id], collection: false }, { resource: "projects", ids: [], collection: true }] } })]);
  expect(mutations).toBe(1); void response;
});

it("lost inner mutation outcome remains uncertain and does not replay", async () => {
  loseMutation = true;
  factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "uncertain", name: "create_map", args: { name: "Actually created" } }, { id: "never", name: "create_map", args: { name: "No" } }] }]);
  const id = await reserveId(); const body = { runId: id, message: "Create" };
  await (await post("/api/assistant/messages", body)).text();
  expect((await receipt(id)).actions).toEqual([expect.objectContaining({ status: "uncertain", effects: { readOnly: false, writes: [{ resource: "maps", ids: [], collection: true }, { resource: "projects", ids: [], collection: true }] } })]);
  await (await post("/api/assistant/messages", body)).text();
  expect(mutations).toBe(1); expect(await (await fetch(origin + "/api/maps")).json()).toHaveLength(1);
});

it("closing a duplicate observer leaves execution alone; explicit cancellation stops it", async () => {
  const entered = deferred(); const aborted = deferred();
  factory.provider = { id: "held", model: "scripted", exchange: () => ({
    async send(_text, options) { entered.resolve(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true })); throw options!.signal!.reason; },
    async continueWith() { throw new Error("No continuation"); },
  }) };
  const id = await reserveId(); const body = { runId: id, message: "Work" };
  const execution = post("/api/assistant/messages", body); await entered.promise;
  const observation = await post("/api/assistant/messages", body); await observation.body!.cancel();
  const read = await fetch(`${origin}/api/assistant/runs/${id}`); await read.body!.cancel();
  expect(assistantRuns.signal(id).aborted).toBe(false); expect((await receipt(id)).state).toBe("running");
  await post(`/api/assistant/runs/${id}/cancel`, {}); await aborted.promise; await (await execution).text(); await interrupted(id);
});

it("accepted asynchronous work retains its job identity and its independent lifecycle after departure", async () => {
  const recipe = createRecipe("Accepted job"); const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS value", name: "accepted_output" } });
  const continued = deferred();
  factory.provider = { id: "scripted", model: "accepted-case", exchange: () => ({
    async send() { return { text: "", toolCalls: [{ id: "job", name: "run_recipe", args: { id: recipe.id, fromStepId: step.id } }] }; },
    async continueWith(_outcomes, options) { continued.resolve(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true })); throw options!.signal!.reason; },
  }) };
  const id = await reserveId(); const controller = new AbortController();
  const response = await post("/api/assistant/messages", { runId: id, message: "Run leaf" }, controller.signal);
  await continued.promise; controller.abort(); await interrupted(id);
  const action = (await receipt(id)).actions[0]; expect(action.status).toBe("accepted"); expect(typeof action.jobId).toBe("string");
  await cascadeSettled(action.jobId);
  expect(readCascade(action.jobId).outcome).toBe("completed");
  expect((await receipt(id)).actions[0].status).toBe("accepted"); void response;
});

it("a lost parked stream remains recoverable, and completed changes stay completed", async () => {
  factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "create", name: "create_map", args: { name: "Parked map" } }] }, (outcomes) => ({ text: "", toolCalls: [{ id: "gate", name: "delete_map", args: { id: JSON.parse(outcomes[0].body).id } }] })]);
  const id = await reserveId(); const response = await post("/api/assistant/messages", { runId: id, message: "Create and delete" });
  await expect.poll(async () => (await receipt(id)).state).toBe("awaiting_confirmation");
  await response.body!.cancel();
  const parked = await receipt(id); expect(parked.state).toBe("awaiting_confirmation");
  const maps = await (await fetch(origin + "/api/maps")).json(); expect(maps).toHaveLength(1);
  expect(parked.pending.args).toEqual({ id: maps[0].id });
  await post(`/api/assistant/runs/${id}/cancel`, {}); expect((await receipt(id)).state).toBe("awaiting_confirmation");
  factory.provider = stubProvider([{ text: "Finished text", toolCalls: [] }]);
  const completed = await reserveId(); await (await post("/api/assistant/messages", { runId: completed, message: "Finish" })).text();
  await post(`/api/assistant/runs/${completed}/cancel`, {}); expect((await receipt(completed)).state).toBe("completed");
});
