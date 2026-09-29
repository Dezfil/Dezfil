import { testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { authenticatedRequest } from "./testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import type { AssistantContext } from "./context";
import { runAssistant, type AssistantEvent, type LoopDeps } from "./loop";
import { PendingActionStore } from "./pending";
import { ProviderError, type ModelProvider, type ProviderReply } from "./provider";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { compactReceipt } from "./recovery-data";
import { assistantRuns, type RecoveryAction, type RunReceipt } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The observation as a separate later fact ('s third case, 6d and 1l's
 * observation state): the render's facts recorded when the check
 * settles, the observation attached when the model's next text arrives,
 * each lifecycle state produced and read back distinctly from the
 * receipt, none as silence; partial output followed by failure; a
 * compacted receipt whose detail is unavailable; a failed check carrying
 * no observation; and a recovery read reproducing the facts while
 * counting zero renders, dispatches and provider calls of its own.
 */
const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://127.0.0.1:3313";
const FIXTURE = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 4) & 0xff)) });
let dir: string; let mapId: string;
const counts = { renders: 0, launches: 0, dispatches: 0 };
const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let launchFails = false;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-observation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3313"); vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent"); vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  closeMetadataDb(); assistantRuns.resetForTests();
  counts.renders = 0; counts.launches = 0; counts.dispatches = 0; launchFails = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin !== origin) throw new Error(`Unexpected fixture network request: ${request.url}`);
    if (mutating.has(request.method) && !new URL(request.url).pathname.startsWith("/api/maps/look") && !new URL(request.url).pathname.startsWith("/api/assistant")) counts.dispatches += 1;
    return dispatchAssistantTestRoute(request);
  });
  mapId = createMap(testAccountScope(), "Observed").id;
  const driver: RenderDriver = { launch: async () => {
    counts.launches += 1;
    if (launchFails) throw new Error("ENOENT");
    return { render: async () => { counts.renders += 1; return { png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }; }, close: async () => {}, kill: () => {} };
  } };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); factory.provider = null; closeMetadataDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const builder = (): AssistantContext => ({ page: "builder", mapId, selectedLayerId: null });
const reply = (text: string, ...toolCalls: { id: string; name: string; args: Record<string, unknown> }[]): ProviderReply => ({ text, toolCalls });
let seq = 0;
const call = (name: string, args: Record<string, unknown>) => ({ id: `o${++seq}`, name, args });
/** Drive the loop as the route does: every event recorded on the run, then finished. */
async function drive(provider: ModelProvider, deps: Partial<LoopDeps> = {}, signal?: AbortSignal): Promise<{ events: AssistantEvent[]; receipt: RunReceipt; threw?: unknown }> {
  const run = assistantRuns.reserve(testAccountScope()); assistantRuns.bind(testAccountScope(), run.id, { message: "go" });
  const events: AssistantEvent[] = [];
  const loop: LoopDeps = { scope: testAccountScope(), baseUrl: origin, fetchImpl: instanceFetch(origin, requireRequestAuth(authenticatedRequest())), pending: new PendingActionStore(), stepBudget: 8, runId: run.id, signal, ...deps };
  let threw: unknown;
  try { for await (const event of runAssistant(provider, { message: "go", history: [], context: builder() }, loop)) { events.push(event); assistantRuns.record(testAccountScope(), run.id, event); } }
  catch (error) { threw = error; assistantRuns.record(testAccountScope(), run.id, { type: "error", code: "internal", message: "x" }); }
  assistantRuns.finish(testAccountScope(), run.id);
  return { events, receipt: assistantRuns.read(testAccountScope(), run.id), threw };
}
const checkAction = (receipt: RunReceipt): RecoveryAction => { const action = receipt.actions.find((a) => a.tool === "look_at_map"); expect(action).toBeDefined(); return action!; };
const observations = (events: AssistantEvent[]) => events.filter((e): e is Extract<AssistantEvent, { type: "observation" }> => e.type === "observation");

describe("4c and 4e: each lifecycle state, read back distinctly", () => {
  it("captured: the model's next text attaches its first sentence to the check, after the render's facts were recorded", async () => {
    const stub = stubProvider([reply("", call("look_at_map", { mapId })), reply("The map shows one point near the centre. Nothing else is drawn.")]);
    const { events, receipt } = await drive(stub);
    const action = checkAction(receipt);
    expect(action.render).toMatchObject({ mapId, image: { width: 1024, height: 640 } });
    expect(action.observation).toMatchObject({ state: "captured", text: "The map shows one point near the centre." });
    expect(typeof action.observation!.at).toBe("number");
    expect(receipt.text.slice(action.observation!.at!).trimStart().startsWith("The map shows one point near the centre.")).toBe(true);
    expect(observations(events)).toEqual([expect.objectContaining({ id: action.id, state: "captured", text: "The map shows one point near the centre." })]);
    // The raw text is unchanged: the receipt holds the whole reply.
    expect(receipt.text).toContain("Nothing else is drawn.");
  });
  it("completed with no text: the turn ends after the check with no subsequent words", async () => {
    const stub = stubProvider([reply("", call("look_at_map", { mapId })), reply("")]);
    const { receipt } = await drive(stub);
    const action = checkAction(receipt);
    expect(action.render).toBeDefined();
    expect(action.observation).toEqual(expect.objectContaining({ state: "silent" }));
    expect(action.observation!.text).toBeUndefined();
  });
  it("an automatic check whose observation reply carries no text is completed with no text, its facts intact", async () => {
    const stub = stubProvider([reply("", call("update_map", { id: mapId, name: "Changed" })), reply("Changed."), reply("")]);
    const { receipt } = await drive(stub);
    const action = checkAction(receipt);
    expect(action.automatic).toBe(true);
    expect(action.render).toBeDefined();
    expect(action.observation).toEqual(expect.objectContaining({ state: "silent" }));
  });
  it("interrupted by exhaustion: a model-requested check on the last step keeps its facts and records why no observation came", async () => {
    const stub = stubProvider([reply("", call("update_map", { id: mapId, name: "X" })), reply("", call("look_at_map", { mapId })), reply("never asked")]);
    const { receipt } = await drive(stub, { stepBudget: 2 });
    expect(receipt.state).toBe("completed");
    const action = checkAction(receipt);
    expect(action.render).toBeDefined();
    expect(action.observation).toEqual(expect.objectContaining({ state: "interrupted", reason: "exhausted" }));
    expect(stub.recording.exchanges[0].outcomes).toHaveLength(1);
  });
  it("interrupted by cancellation during the observation: the facts stay, no further provider call", async () => {
    const controller = new AbortController();
    const stub = stubProvider([reply("", call("look_at_map", { mapId })), reply("The map"), reply("never")]);
    let calls = 0;
    const provider: ModelProvider = { id: "stub", model: "scripted", exchange(options) {
      const exchange = stub.exchange(options);
      return { ...exchange, async continueWith(outcomes, control) {
        calls += 1;
        const value = await exchange.continueWith(outcomes);
        control?.onTextDelta?.(value.text);
        // The departure lands while the observation streams.
        controller.abort(new DOMException("Execution departed", "AbortError"));
        throw controller.signal.reason;
      } };
    } };
    const { events, receipt } = await drive(provider, {}, controller.signal);
    expect(events.at(-1)).toEqual({ type: "done", reason: "interrupted" });
    const action = checkAction(receipt);
    expect(action.render).toBeDefined();
    expect(action.observation).toEqual(expect.objectContaining({ state: "interrupted", reason: "cancelled" }));
    expect(calls).toBe(1);
  });
  it("partial output followed by failure: interrupted as failed, the facts intact, the partial words never a captured observation", async () => {
    const stub = stubProvider([reply("", call("look_at_map", { mapId })), reply("The map"), reply("never")]);
    const provider: ModelProvider = { id: "stub", model: "scripted", exchange(options) {
      const exchange = stub.exchange(options);
      return { ...exchange, async continueWith(outcomes, control) {
        const value = await exchange.continueWith(outcomes);
        control?.onTextDelta?.(value.text);
        throw new ProviderError("The model response ended before a complete reply.", "provider");
      } };
    } };
    const { events, receipt } = await drive(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
    const action = checkAction(receipt);
    expect(action.render).toBeDefined();
    expect(action.observation).toEqual(expect.objectContaining({ state: "interrupted", reason: "failed" }));
    expect(action.observation!.text).toBeUndefined();
  });
  it("awaited while the run is live: a receipt read after the check settled and before the text shows the state, not silence", () => {
    const run = assistantRuns.reserve(testAccountScope()); assistantRuns.bind(testAccountScope(), run.id, { message: "go" });
    assistantRuns.record(testAccountScope(), run.id, { type: "tool_call", id: "look-x", tool: "look_at_map", args: { mapId } });
    assistantRuns.record(testAccountScope(), run.id, { type: "tool_result", id: "look-x", tool: "look_at_map", ok: true, body: {}, outcome: "succeeded", render: { id: "r", mapId, mapName: "Observed", appearance: "light", state: { map: mapId, camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], appearance: "light", digest: "0" }, image: { width: 1024, height: 640, bytes: 1 }, source: { width: 1024, height: 640 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1 } });
    const live = assistantRuns.read(testAccountScope(), run.id);
    expect(live.state).toBe("running");
    expect(checkAction(live).observation).toEqual(expect.objectContaining({ state: "awaited" }));
  });
});

describe("a failed check carries no observation", () => {
  it("no browser: the check is not done, and the model's later text attaches to nothing", async () => {
    launchFails = true;
    const stub = stubProvider([reply("", call("look_at_map", { mapId })), reply("I could not see the map, but here is what I would expect.")]);
    const { receipt } = await drive(stub);
    const action = checkAction(receipt);
    expect(action.status).toBe("refused");
    expect(action.render).toBeUndefined();
    expect(action.observation).toBeUndefined();
    expect(counts.renders).toBe(0);
  });
});

describe("reporting a failure costs no new work", () => {
  it("inside the budget the failure reaches the model in the next request; with the budget spent no further provider call is made", async () => {
    launchFails = true;
    const roomy = stubProvider([reply("", call("look_at_map", { mapId })), reply("I could not see it.")]);
    await drive(roomy, { stepBudget: 8 });
    const outcomes = roomy.recording.exchanges[0].outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0][0].isError).toBe(true);
    expect(outcomes[0][0].body).toContain("render_unavailable");
    expect(outcomes[0][0].image).toBeUndefined();
    const spent = stubProvider([reply("", call("look_at_map", { mapId })), reply("never asked")]);
    const { events, receipt } = await drive(spent, { stepBudget: 1 });
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
    expect(spent.recording.exchanges[0].outcomes).toHaveLength(0);
    expect(checkAction(receipt).status).toBe("refused");
    expect(counts.launches).toBe(2);
  });
});

describe("compaction leaves unavailable detail distinguishable from silence", () => {
  const facts = { id: "r", mapId: "m", mapName: "M", appearance: "light" as const, state: { map: "m", camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, layers: Array.from({ length: 40 }, (_, i) => ({ id: `layer-${i}`, filters: "0000000000000000" })), legend: { visible: true, corner: "bottom-left", order: [] }, widgets: [], appearance: "light" as const, digest: "abcdefabcdefabcd" }, image: { width: 1024, height: 640, bytes: 1 }, source: { width: 1024, height: 640 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1 };
  const receiptWith = (observation: RecoveryAction["observation"]): RunReceipt => ({
    id: "run", state: "completed", text: "x".repeat(4000), incomplete: false,
    actions: [{ id: "look-1", tool: "look_at_map", args: { mapId: "m" }, status: "succeeded", render: facts, observation }],
  });
  it("a captured observation's text is dropped under the terminal bound and the state reads unavailable, its render identity kept", () => {
    const compact = compactReceipt(receiptWith({ state: "captured", text: "Seen.", at: 0 }), 2500, true);
    const action = compact.actions[0];
    expect(action.observation).toEqual({ state: "unavailable" });
    expect(action.render?.id).toBe("r");
    expect(action.render?.state.digest).toBe("abcdefabcdefabcd");
    expect(action.omitted).toBe(true);
  });
  it("a silent observation stays silent under the same bound: not the same thing as unavailable", () => {
    const compact = compactReceipt(receiptWith({ state: "silent" }), 2500, true);
    expect(compact.actions[0].observation).toEqual({ state: "silent" });
  });
  it("state detail dropped under the bound is absent, never an empty list read as zero layers and widgets", () => {
    const receipt = receiptWith({ state: "silent" });
    receipt.text = "";
    receipt.actions[0].render = { ...facts, state: { ...facts.state, widgets: ["w-1", "w-2"], legend: { ...facts.state.legend, order: ["layer-0"] } } };
    const compact = compactReceipt(receipt, 1200, true);
    const render = compact.actions[0].render!;
    // Seeded defect on the shipped compaction: the arrays were emptied, and the pane counted them as "0 visible layers, 0 widgets".
    expect(render.state.layers).toBeUndefined();
    expect(render.state.widgets).toBeUndefined();
    expect(render.state.legend.order).toBeUndefined();
    expect(render.state.digest).toBe("abcdefabcdefabcd");
    expect(compact.actions[0].omitted).toBe(true);
  });
  it("under the bound nothing is dropped", () => {
    const compact = compactReceipt(receiptWith({ state: "captured", text: "Seen.", at: 0 }), 64 * 1024, true);
    expect(compact.actions[0].observation).toEqual({ state: "captured", text: "Seen.", at: 0 });
    expect(compact.actions[0].render?.state.layers).toHaveLength(40);
  });
});

describe("a recovery read reproduces the facts and starts nothing", () => {
  async function throughRoute(script: ScriptEntry[], dropAfterCheck = false) {
    factory.provider = stubProvider(script);
    const reserved = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string };
    const response = await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: reserved.id, message: "go", history: [], context: builder() }) }));
    expect(response.ok).toBe(true);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""; let dropped = false;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AssistantEvent;
        // A dropped stream (departure cancels execution) once the check itself has settled.
        if (dropAfterCheck && event.type === "tool_result" && event.tool === "look_at_map") { dropped = true; break; }
      }
      if (dropped) { await reader.cancel(); break; }
    }
    for (let i = 0; i < 300; i += 1) { const r = assistantRuns.read(testAccountScope(), reserved.id); if (r.state !== "running") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    return reserved.id;
  }
  const read = async (id: string) => (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${id}`))).json() as Promise<RunReceipt>;
  it("after a completed run, the read carries the render facts and the captured observation, at no cost", async () => {
    const id = await throughRoute([reply("", call("update_map", { id: mapId, name: "Recovered" })), reply("Renamed."), reply("One point, centred. Good.")]);
    const before = { ...counts };
    const receipt = await read(id);
    expect(receipt.state).toBe("completed");
    const action = checkAction(receipt);
    expect(action.automatic).toBe(true);
    expect(action.render).toMatchObject({ mapId });
    expect(action.observation).toMatchObject({ state: "captured", text: "One point, centred." });
    expect(counts).toEqual(before);
  });
  it("a dropped stream departs the run: the read reproduces what had authoritatively arrived, the check's facts intact, its observation in its true state", async () => {
    const id = await throughRoute([reply("", call("update_map", { id: mapId, name: "Dropped" })), reply("Renamed."), reply("Still one point.")], true);
    const before = { ...counts };
    const receipt = await read(id);
    expect(["interrupted", "completed"]).toContain(receipt.state);
    const action = checkAction(receipt);
    expect(action.render).toBeDefined();
    expect(action.automatic).toBe(true);
    // Either the observation raced in before the departure, or the departure interrupted it; never
    // silence, never absence.
    expect(["captured", "interrupted"]).toContain(action.observation?.state);
    if (action.observation?.state === "interrupted") expect(action.observation.reason).toBe("cancelled");
    expect(counts).toEqual(before);
    expect(counts.renders).toBe(1);
  });
});

describe("a parked run released by Stop", () => {
  it("interrupts the check's awaited observation as cancelled, never leaving it awaited", () => {
    const run = assistantRuns.reserve(testAccountScope()); assistantRuns.bind(testAccountScope(), run.id, { message: "go" });
    assistantRuns.record(testAccountScope(), run.id, { type: "tool_call", id: "look-p", tool: "look_at_map", args: { mapId } });
    assistantRuns.record(testAccountScope(), run.id, { type: "tool_result", id: "look-p", tool: "look_at_map", ok: true, body: {}, outcome: "succeeded", render: { id: "r", mapId, mapName: "Observed", appearance: "light", state: { map: mapId, camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], appearance: "light", digest: "0" }, image: { width: 1024, height: 640, bytes: 1 }, source: { width: 1024, height: 640 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1 } });
    assistantRuns.record(testAccountScope(), run.id, { type: "confirm_required", id: "pending-1", tool: "delete_layer", args: { id: "l" }, callId: "c-2" });
    assistantRuns.release(testAccountScope(), run.id);
    const receipt = assistantRuns.read(testAccountScope(), run.id);
    expect(receipt.state).toBe("interrupted");
    expect(checkAction(receipt).observation).toEqual(expect.objectContaining({ state: "interrupted", reason: "cancelled" }));
  });
});
