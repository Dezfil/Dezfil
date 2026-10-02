import { testAccountScope } from "@/lib/test-support/accounts";
// Ordinary CI proves the scenario harness with a scripted provider. Explicit
// DEZFIL_ASSISTANT_LIVE=openai|anthropic replaces only the provider seam with
// that vendor, on isolated real routes/data. It never discovers credentials.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { DEFAULT_MODELS } from "./config";
import type { HistoryTurn, ModelProvider, ProviderReply } from "./provider";
import type { AssistantEvent } from "./loop";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { openaiProvider } from "./providers/openai";
import { anthropicProvider } from "./providers/anthropic";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
const live = process.env.DEZFIL_ASSISTANT_LIVE;
if (live && !["openai", "anthropic"].includes(live)) throw new Error("DEZFIL_ASSISTANT_LIVE must be openai or anthropic");
// Count model-requested instance/schema discovery, excluding automatic grounding
// and result evaluation (SQL, render, export). Retain the names for auditability.
const discoveryTools = new Set([
  "list_tables", "inspect_table", "read_table_catalogue", "inspect_table_geometry",
  "list_maps", "get_map", "list_layers", "get_layer", "list_layer_fields", "get_field_stats",
  "list_projects", "get_project", "get_project_members", "list_recipes", "get_recipe",
  "get_recipe_step", "list_recipe_runs", "get_recipe_run",
]);
const wireFetch = globalThis.fetch;
const origin = "http://127.0.0.1:3201";
const call = (name: string, args: Record<string, unknown>) => ({ id: randomUUID(), name, args });
const reply = (text: string, ...toolCalls: ReturnType<typeof call>[]): ProviderReply => ({ text, toolCalls });
let dir: string;
let context: { page: "builder"; mapId: string; selectedLayerId: string };
let otherLayer: string;
interface ObservedRun { id: string; parentRunId?: string; message: string; history: HistoryTurn[]; receipt?: unknown }
let evidence: { runLineage: ObservedRun[]; scenario: string; configuredModel: string; returnedModels: string[]; events: AssistantEvent[]; outcomes: Record<string, unknown> };
async function api(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await dispatchAssistantTestRoute(new Request(origin + url, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }));
  expect(response.ok, `${method} ${url}: ${response.status}`).toBe(true);
  return response.json();
}
async function stream(body: unknown) {
  const response = await dispatchAssistantTestRoute(new Request(origin + "/api/assistant/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`Assistant ${response.status}: ${await response.text()}`);
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const events: AssistantEvent[] = [];
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AssistantEvent;
      events.push(event); evidence.events.push(event);
      if (event.type === "message" && event.model) evidence.returnedModels.push(event.model);
    }
  }
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  return events;
}
async function start(message: string, history: HistoryTurn[] = [], parentRunId?: string) {
  const reserved = await api("/api/assistant/runs", {});
  const attempt: ObservedRun = { id: reserved.id, parentRunId, message, history };
  evidence.runLineage.push(attempt);
  try {
    const events = await stream({ runId: reserved.id, message, history, context });
    return { events, id: reserved.id as string };
  } finally {
    attempt.receipt = await api(`/api/assistant/runs/${reserved.id}`);
  }
}
function configure(provider: "openai" | "anthropic", script: ScriptEntry[]) {
  const model = process.env.DEZFIL_AI_MODEL || DEFAULT_MODELS[provider];
  evidence.configuredModel = live ? model : "scripted";
  if (live) {
    const key = process.env[provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
    expect(key, `Set ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} in the supervising session environment`).toBeTruthy();
    factory.provider = provider === "openai" ? openaiProvider(key!, model, wireFetch) : anthropicProvider(key!, model, wireFetch);
  } else {
    const stub = stubProvider(script);
    // Exercise the live scenario's incremental assertions in CI through the
    // exact callback seam the real adapters implement; vendor wire behavior has
    // its separate held-stream tests.
    factory.provider = { id: provider, model: "scripted", exchange(options) {
      const exchange = stub.exchange(options);
      async function emitted(response: Promise<ProviderReply>, control?: { onTextDelta?: (text: string) => void }) {
        const value = await response;
        if (value.text) control?.onTextDelta?.(value.text);
        return { ...value, model: "scripted" };
      }
      return { setGrounding: exchange.setGrounding,
        send: (text, control) => emitted(exchange.send(text), control),
        continueWith: (outcomes, control) => emitted(exchange.continueWith(outcomes), control) };
    } };
    return stub.recording;
  }
}
function observedText(events: AssistantEvent[]) { return events.flatMap((event) => event.type === "message" ? [event.text] : []).join("\n"); }

for (const provider of ["openai", "anthropic"] as const) describe.skipIf(Boolean(live && live !== provider))(`${provider} ${live? "LIVE": "scripted harness"}`, () => {
  beforeEach(async (test) => {
    await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-provider-suite-"));
    // The automatic map check has its own suites; this one asserts its turns' exact actions.
    vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
    vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3201"); vi.stubEnv("DEZFIL_AI_PROVIDER", provider);
    if (!live) vi.stubEnv(provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", "fixture-never-sent");
    closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).origin !== origin) throw new Error("Unexpected fixture network request");
      return dispatchAssistantTestRoute(request);
    });
    evidence = { runLineage: [], scenario: test.task.name, configuredModel: "", returnedModels: [], events: [], outcomes: {} };
    const csv = path.join(dir, "population.csv");
    await writeFile(csv, "lon,lat,population\n13.4,52.5,100\n13.5,52.6,200\n");
    await ingestFile(testAccountScope(), csv, "population.csv");
    const map = createMap(testAccountScope(), "Scenario map");
    const layer = await createLayer(testAccountScope(), map.id, { name: "Selected population", sql: "SELECT * FROM population" });
    const second = await createLayer(testAccountScope(), map.id, { name: "Other population", sql: "SELECT * FROM population" });
    context = { page: "builder", mapId: map.id, selectedLayerId: layer.id }; otherLayer = second.id;
  });
  afterEach(async (test) => {
    if (live) {
      const discoveryToolCalls = evidence.events.flatMap((event) => event.type === "tool_call" && discoveryTools.has(event.tool) ? [event.tool] : []);
      const report = { at: new Date().toISOString(), provider, ...evidence, discoveryToolCalls, discoveryToolCallCount: discoveryToolCalls.length, returnedModels: [...new Set(evidence.returnedModels)], testState: test.task.result?.state ?? "unknown" };
      const evidenceDir = path.join(process.cwd(), "perf-logs/assistant");
      await mkdir(evidenceDir, { recursive: true });
      await appendFile(path.join(evidenceDir, `live-${provider}-evidence.jsonl`), JSON.stringify(report) + "\n");
      console.info(JSON.stringify({ provider, scenario: evidence.scenario, configuredModel: evidence.configuredModel, returnedModels: report.returnedModels, discoveryToolCallCount: report.discoveryToolCallCount, discoveryToolCalls, outcomes: evidence.outcomes }));
    }
    closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  it("selected-layer refinement changes only the selected effective result", async () => {
    const before = await api(`/api/layers/${context.selectedLayerId}/export/geojson`);
    const otherBefore = await api(`/api/layers/${otherLayer}`);
    const otherResultBefore = await api(`/api/layers/${otherLayer}/export/geojson`);
    const refinement = provider === "openai"
      ? { filters: [{ kind: "range", field: "population", min: 150, max: null }] }
      : { sql: "SELECT * FROM population WHERE population >= 150" };
    configure(provider, [reply("I will filter the selected layer.", call("update_layer", { id: context.selectedLayerId, ...refinement })), reply("The selected layer now shows population of at least 150.")]);
    const { id } = await start("Filter this selected layer to population >= 150, keeping its geometry and all columns. Keep the other layer as it is.");
    const selected = await api(`/api/layers/${context.selectedLayerId}`);
    const other = await api(`/api/layers/${otherLayer}`);
    // This documented read evaluates the layer's SQL AND stored filters, even
    // when the renderer delegates filters to the browser for interactive use.
    const result = await api(`/api/layers/${context.selectedLayerId}/export/geojson`);
    const otherResult = await api(`/api/layers/${otherLayer}/export/geojson`);
    evidence.outcomes = { selected, other, result, otherResult, receipt: await api(`/api/assistant/runs/${id}`) };
    expect(other).toEqual({ ...otherBefore, editRevision: selected.editRevision,
      lastChangedAt: selected.lastChangedAt, lastChangedBy: selected.lastChangedBy });
    expect(other.editRevision).not.toBe(otherBefore.editRevision);
    expect(otherResult.features).toEqual(otherResultBefore.features);
    expect(result.features).toHaveLength(1);
    expect(Number(result.features[0].properties.population)).toBe(200);
    const expected = before.features.find((feature: { properties: { population: number } }) => Number(feature.properties.population) === 200);
    expect(expected).toBeDefined(); expect(result.features[0]).toEqual(expected);
    expect(result.features[0].geometry).toMatchObject({ type: "Point", coordinates: [13.5, 52.6] });
    expect(Object.keys(result.features[0].properties)).toEqual(expect.arrayContaining(["population", "lon", "lat"]));
    expect(evidence.returnedModels.length).toBeGreaterThan(0);
  }, 180_000);
  it("missing-data honesty refuses to invent a dataset or new map", async () => {
    configure(provider, [reply("The missing_schools_absent dataset is not available. Upload it to continue.")]);
    const before = await api("/api/maps");
    const { events, id } = await start("Map the missing_schools_absent dataset. If this instance does not contain it, explain what is missing.");
    const receipt = await api(`/api/assistant/runs/${id}`);
    evidence.outcomes = { text: observedText(events), receipt, maps: await api("/api/maps") };
    expect(observedText(events)).toMatch(/missing|unavailable|not (?:available|found|present|contain)|doesn.t (?:exist|contain)|upload/i);
    expect(await api("/api/maps")).toEqual(before);
    expect(receipt.actions.filter((a: { status: string; effects?: { readOnly: boolean } }) => a.status === "succeeded" && a.effects?.readOnly === false)).toEqual([]);
    expect(evidence.returnedModels.length).toBeGreaterThan(0);
  }, 180_000);
  for (const approved of [true, false]) it(`create then publish with ${approved ? "approval" : "decline"}`, async () => {
    const name = `Live publication ${approved ? "approved" : "declined"}`;
    const asksInProse = provider === "openai" && approved;
    let createdId = "";
    const recording = configure(provider, [reply("I will create the map.", call("create_map", { name })), (outcomes) => {
      createdId = JSON.parse(outcomes[0].body).id;
      return asksInProse ? reply(`Created ${name} (${createdId}). Would you like me to publish it now?`)
        : reply("Publication needs your confirmation.", call("publish_map", { id: createdId }));
    }, ...(asksInProse ? [() => reply("Publication needs your confirmation.", call("publish_map", { id: createdId }))] : []),
    reply(approved ? "The map is published." : "Publication was declined.")]);
    const instruction = `Create one empty map named "${name}", and then publish it; do not ask, publish it.`;
    let { id, events } = await start(instruction);
    let receipt = await api(`/api/assistant/runs/${id}`);
    let created = (await api("/api/maps")).filter((map: { name: string }) => map.name === name);
    evidence.outcomes = { created, receipt };
    if (receipt.state === "completed" && /publish|publication/i.test(observedText(events)) && observedText(events).includes("?")) {
      const history: HistoryTurn[] = [{ role: "user", text: instruction }, { role: "assistant", text: observedText(events) }];
      ({ id, events } = await start("Yes, publish it", history, id));
      receipt = await api(`/api/assistant/runs/${id}`);
      created = (await api("/api/maps")).filter((map: { name: string }) => map.name === name);
      evidence.outcomes = { created, receipt };
    }
    expect(receipt.state).toBe("awaiting_confirmation"); expect(receipt.pending.tool).toBe("publish_map");
    expect(created).toHaveLength(1); expect(receipt.pending.args.id).toBe(created[0].id);
    await stream({ resolution: { pending: receipt.pending.id, approved } });
    const outcome = await api(`/api/assistant/runs/${id}`);
    const map = await api(`/api/maps/${created[0].id}`);
    evidence.outcomes = { created, map, receipt: outcome };
    if (recording && asksInProse) {
      expect(recording.exchanges).toHaveLength(2);
      expect(recording.exchanges[1].userText).toBe("Yes, publish it");
      expect(recording.exchanges[1].options.history).toEqual([
        { role: "user", text: instruction },
        { role: "assistant", text: expect.stringContaining(createdId) },
      ]);
      expect(evidence.runLineage[1].parentRunId).toBe(evidence.runLineage[0].id);
    }
    expect(outcome.state).toBe("completed"); expect(Boolean(map.publishToken)).toBe(approved);
    expect((await api("/api/maps")).filter((m: { name: string }) => m.name === name)).toHaveLength(1);
    expect(evidence.returnedModels.length).toBeGreaterThan(0);
  }, 240_000);
  it("multi-step turn carries incremental text and independently observable outcomes", async () => {
    configure(provider, [reply("I will rename the map, then the layer.", call("update_map", { id: context.mapId, name: "Refined scenario" })),
      reply("The map is renamed. Next is the layer.", call("update_layer", { id: context.selectedLayerId, name: "Population refined" })), reply("Both names are updated.")]);
    const { events, id } = await start('Briefly explain what you are about to do, then rename this map to "Refined scenario" and the selected layer to "Population refined". Summarize after both changes.');
    const map = await api(`/api/maps/${context.mapId}`); const layer = await api(`/api/layers/${context.selectedLayerId}`);
    evidence.outcomes = { mapName: map.name, layerName: layer.name, receipt: await api(`/api/assistant/runs/${id}`) };
    expect(map.name).toBe("Refined scenario"); expect(layer.name).toBe("Population refined");
    expect(events.filter((e) => e.type === "tool_result" && e.ok).length).toBeGreaterThanOrEqual(2);
    const delta = events.findIndex((e) => e.type === "text_delta");
    const completion = events.findIndex((e) => e.type === "message" && e.text.length > 0);
    expect(delta).toBeGreaterThanOrEqual(0); expect(completion).toBeGreaterThan(delta);
    expect(evidence.returnedModels.length).toBeGreaterThan(0);
  }, 180_000);
});
