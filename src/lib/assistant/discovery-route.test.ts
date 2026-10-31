import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { buildTools } from "@/lib/tools/tools";
import type { AssistantContext } from "./context";
import { DISCOVERY_TOOL } from "./discovery";
import { runAssistant, type AssistantEvent } from "./loop";
import { defaultOffer } from "./offer";
import { PendingActionStore } from "./pending";
import { admittedTools, policyFor } from "./policy";
import type { ModelProvider } from "./provider";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { anthropicWire, outputCall, outputText, responseWire } from "./testing/wire";

/**
 * Offers and discovery. The captured offer per page through the real
 * route; a simulated model that selects only from the offer it is shown,
 * on both real adapters through a scripted vendor wire, failing its
 * outcome with discovery off and succeeding with it on; a discovered
 * operation callable on the next request and across a confirmation
 * continuation, inside the budget, under the run's original policy,
 * cancellation still stopping the turn.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://localhost:3206";
const origins = new Set([origin, "http://127.0.0.1:3206"]);
let dir: string;
let dispatched: { method: string; path: string }[];
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-discovery-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3206");
  // The subset is this suite's subject and, since the live arm,
  // the measured default: nothing configured. 6a also
  // captures the configured full mode.
  vi.stubEnv("DEZFIL_ASSISTANT_OFFER", "");
  closeMetadataDb(); resetQueryInstance(); dispatched = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!origins.has(url.origin)) throw new Error(`Unexpected fixture network request: ${request.url}`);
    dispatched.push({ method: request.method, path: url.pathname });
    return dispatchAssistantTestRoute(request);
  });
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function events(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text(); expect(response.status, text).toBe(200);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function turn(script: ScriptEntry[], context?: AssistantContext, message = "Work") {
  const provider = stubProvider(script); factory.provider = provider;
  const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
  const stream = await events(await api("/api/assistant/messages", { runId, message, ...(context ? { context } : {}) }));
  return { runId, provider, stream };
}
async function seed() {
  const csv = path.join(dir, "facts.csv"); await writeFile(csv, "city,lon,lat,value\nBerlin,13.4,52.5,4\n");
  await ingestFile(testAccountScope(), csv, "facts.csv");
  const map = createMap(testAccountScope(), "Original map");
  const recipe = createRecipe(testAccountScope(), "Workflow");
  const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "output" } });
  return {
    map,
    builder: { page: "builder", mapId: map.id, selectedLayerId: null } as AssistantContext,
    sql: { page: "sql", draft: "", selection: null, lastExecution: null } as AssistantContext,
    workflow: { page: "workflow", recipeId: recipe.id, selectedStepId: step.id, lastRunId: null } as AssistantContext,
  };
}
const names = (set: { name: string }[]) => set.map((t) => t.name).sort();
const STOPS = [{ color: "#e6f2ea", position: 0 }, { color: "#0d7d5c", position: 1 }];
const palettes = async (label: string) => ((await (await api("/api/palettes")).json()) as { custom: { label: string }[] }).custom.filter((p) => p.label === label);
type Result = Extract<AssistantEvent, { type: "tool_result" }>;
const results = (stream: AssistantEvent[]) => stream.filter((e): e is Result => e.type === "tool_result");

describe("the captured offer per page", () => {
  it("under the measured default is inside admission and holds the page's derived offer with discovery; under the configured full mode it is the admitted set with nothing to discover; no context keeps the full set", async () => {
    const seeded = await seed();
    for (const page of ["builder", "sql", "workflow"] as const) {
      const context = seeded[page];
      const { provider } = await turn([{ text: "Captured", toolCalls: [] }], context);
      const captured = names(provider.recording.exchanges[0].options.tools);
      const policy = policyFor(context);
      const admitted = new Set(names(admittedTools(policy)));
      expect(captured).toEqual([...names(defaultOffer(page, policy, buildTools(), "subset")), DISCOVERY_TOOL].sort());
      expect(captured.length).toBeLessThan(admitted.size + 1);
      for (const name of captured) if (name !== DISCOVERY_TOOL) expect(admitted.has(name), `${name} on ${page}`).toBe(true);
    }
    const { provider } = await turn([{ text: "Captured", toolCalls: [] }]);
    expect(names(provider.recording.exchanges[0].options.tools)).toEqual(names(admittedTools("full")));
    // The configured full mode: every admitted operation offered, discovery not needed and not
    // offered.
    vi.stubEnv("DEZFIL_ASSISTANT_OFFER", "full");
    for (const page of ["builder", "sql", "workflow"] as const) {
      const context = seeded[page];
      const { provider: full } = await turn([{ text: "Captured", toolCalls: [] }], context);
      const captured = names(full.recording.exchanges[0].options.tools);
      expect(captured, `the configured full offer on ${page}`).toEqual(names(admittedTools(policyFor(context))));
      expect(captured).not.toContain(DISCOVERY_TOOL);
    }
  });
});

/** A vendor that selects from the tools the request carries: it saves
 * the palette when offered create_palette, asks discovery when offered
 * that, and gives up otherwise; once the palette is saved it answers in
 * words. Read from the serialized request, on each adapter's wire. */
function offerSensitiveWire(vendor: "openai" | "anthropic", label: string) {
  let calls = 0; let saved = false;
  const wire: typeof fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { tools?: { name: string }[] };
    const offered = new Set((body.tools ?? []).map((t) => t.name));
    const call = saved ? null : offered.has("create_palette") ? { name: "create_palette", args: { label, stops: STOPS } }
      : offered.has(DISCOVERY_TOOL) ? { name: DISCOVERY_TOOL, args: { query: "save a palette" } } : null;
    if (call?.name === "create_palette") saved = true;
    const text = saved ? "Saved." : "I cannot do that with the tools I have.";
    if (vendor === "openai") {
      return responseWire(call ? [outputCall(`c${calls}`, call.name, JSON.stringify(call.args))] : [outputText(text)]);
    }
    return anthropicWire({ model: "claude-opus-5", stop_reason: call ? "tool_use" : "end_turn", content: call
      ? [{ type: "tool_use", id: `c${calls}`, name: call.name, input: call.args }]
      : [{ type: "text", text }] });
  };
  return { wire, calls: () => calls };
}
async function drive(provider: ModelProvider, context: AssistantContext, discovery: boolean) {
  const out: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "Save these greens as a palette", history: [], context }, { scope: testAccountScope(), baseUrl: origin, pending: new PendingActionStore(), discovery, stepBudget: 6 })) out.push(event);
  return out;
}

describe("the model's selection depends on the offer, on both adapters", () => {
  for (const vendor of ["openai", "anthropic"] as const) {
    it(`${vendor}: with discovery off the omitted operation cannot be selected and the scenario fails its outcome; with it on the palette lands`, async () => {
      const { builder } = await seed();
      const label = `Evening ${vendor}`;
      const { wire, calls } = offerSensitiveWire(vendor, label);
      const provider = vendor === "openai" ? openaiProvider("fixture", "gpt-6-astra", wire) : anthropicProvider("fixture", "claude-opus-5", wire);
      // The control: discovery off, the subset offer omits create_palette, the model gives up.
      const off = await drive(provider, builder, false);
      expect(off.some((e) => e.type === "tool_call")).toBe(false);
      expect(await palettes(label)).toHaveLength(0);
      expect(calls()).toBe(1);
      // Discovery on: found, extended, called on the next request, the palette read independently.
      const on = await drive(provider, builder, true);
      expect(results(on).map((r) => [r.tool, r.ok])).toEqual([[DISCOVERY_TOOL, true], ["create_palette", true]]);
      expect(await palettes(label)).toHaveLength(1);
      expect(dispatched.filter((d) => d.method === "POST" && d.path === "/api/palettes")).toHaveLength(1);
      expect(calls()).toBe(4);
    });
  }
});

describe("a discovered operation stays callable", () => {
  it("on the next request and across a confirmation continuation, inside the budget, under the original policy", async () => {
    const { map, builder } = await seed();
    const offersPalette = (offered: { name: string }[]) => offered.some((t) => t.name === "create_palette");
    const { stream, provider } = await turn([
      (_, offered) => { expect(offersPalette(offered)).toBe(false); return { text: "", toolCalls: [{ id: "find-1", name: DISCOVERY_TOOL, args: { query: "save a palette" } }] }; },
      (_, offered) => { expect(offersPalette(offered)).toBe(true); return { text: "", toolCalls: [{ id: "pal-1", name: "create_palette", args: { label: "Evening one", stops: STOPS } }, { id: "publish-1", name: "publish_map", args: { id: map.id } }] }; },
      (_, offered) => { expect(offersPalette(offered)).toBe(true); return { text: "", toolCalls: [{ id: "pal-2", name: "create_palette", args: { label: "Evening two", stops: STOPS } }] }; },
      { text: "Done", toolCalls: [] },
    ], builder, "Save two palettes around a publish");
    const found = results(stream).find((r) => r.tool === DISCOVERY_TOOL)!;
    expect(found.ok).toBe(true);
    expect((found.body as { operations: { name: string }[] }).operations.map((o) => o.name)).toContain("create_palette");
    expect(found.label).toBe('Looked up operations for "save a palette"');
    expect(provider.recording.exchanges[0].extensions.flat().map((t) => t.name)).toContain("create_palette");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    expect(await palettes("Evening one")).toHaveLength(1);
    const resumed = await events(await api("/api/assistant/messages", { resolution: { pending: pending.id, approved: true } }));
    expect(results(resumed).map((r) => [r.tool, r.ok])).toEqual([["publish_map", true], ["create_palette", true]]);
    expect(await palettes("Evening two")).toHaveLength(1);
    expect(dispatched.filter((d) => d.method === "POST" && d.path === "/api/palettes")).toHaveLength(2);
  });
  it("cannot widen admission: under /sql discovery finds no write, and the write called anyway never dispatches and is recorded refused", async () => {
    const { map, sql } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "find-2", name: DISCOVERY_TOOL, args: { query: "update map name" } }] },
      { text: "", toolCalls: [{ id: "write-2", name: "update_map", args: { id: map.id, name: "Renamed by the model" } }] },
      { text: "Done", toolCalls: [] },
    ], sql, "Rename the map");
    const [found, refused] = results(stream);
    // The demonstrably mutating operation, first: the resource read independently is unchanged, and
    // no PATCH was dispatched.
    expect(((await (await api(`/api/maps/${map.id}`)).json()) as { name: string }).name).toBe("Original map");
    expect(dispatched.filter((d) => d.method === "PATCH")).toEqual([]);
    expect((found.body as { operations: { name: string }[] }).operations.map((o) => o.name)).not.toContain("update_map");
    expect(refused).toMatchObject({ tool: "update_map", ok: false, outcome: "refused", body: { error: { code: "assistant_action_not_admitted" } } });
    expect((await (await api(`/api/assistant/runs/${runId}`)).json() as { actions: { tool: string; status: string }[] }).actions).toEqual([
      expect.objectContaining({ tool: DISCOVERY_TOOL, status: "succeeded" }), expect.objectContaining({ tool: "update_map", status: "refused" }),
    ]);
  });
  it("spends the budget and stops on cancellation like any call", async () => {
    const { map, builder } = await seed();
    const controller = new AbortController();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "find-3", name: DISCOVERY_TOOL, args: { query: "palette" } }] },
      { text: "", toolCalls: [{ id: "pal-3", name: "create_palette", args: { label: "Evening three", stops: STOPS } }] },
      { text: "Never reached", toolCalls: [] },
    ]);
    void map;
    const out: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Save", history: [], context: builder }, { scope: testAccountScope(), baseUrl: origin, pending: new PendingActionStore(), stepBudget: 2 })) out.push(event);
    expect(out.at(-1)).toEqual({ type: "done", reason: "budget" });
    expect(results(out).map((r) => r.tool)).toEqual([DISCOVERY_TOOL, "create_palette"]);
    const cancelled: AssistantEvent[] = [];
    const late = stubProvider([() => { controller.abort(); return { text: "", toolCalls: [{ id: "find-4", name: DISCOVERY_TOOL, args: { query: "palette" } }] }; }]);
    for await (const event of runAssistant(late, { message: "Save", history: [], context: builder }, { scope: testAccountScope(), baseUrl: origin, pending: new PendingActionStore(), signal: controller.signal })) cancelled.push(event);
    expect(cancelled).toEqual([{ type: "done", reason: "interrupted" }]);
  });
});
