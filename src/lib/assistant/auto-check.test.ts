import { requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { authenticatedRequest } from "./testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, mapWithLayers } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import type { AssistantContext } from "./context";
import { qualifyingChange } from "./auto-check";
import { resumeAssistant, runAssistant, type AssistantEvent, type LoopDeps } from "./loop";
import { PendingActionStore } from "./pending";
import { ProviderError, type ProviderReply } from "./provider";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * Automatic scheduling and where it stops, over the real routes with
 * the render stubbed at the check module's seam and a scripted model:
 * physical renders counted at the driver, provider requests at the
 * stub, product dispatches at the fetch seam, each independently. Every
 * rule has its own case; the seeds that remove a guard are applied to
 * the shipped decision at task 11 and recorded in the verification
 * record.
 */
const origin = "http://127.0.0.1:3312";
const FIXTURE = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 3) & 0xff)) });
let dir: string; let mapId: string; let layerId: string; let table: string;
const counts = { renders: 0, dispatches: 0, appearances: [] as string[], namesAtRender: [] as string[] };
const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-auto-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3312");
  closeMetadataDb(); resetQueryInstance();
  counts.renders = 0; counts.dispatches = 0; counts.appearances = []; counts.namesAtRender = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin !== origin) throw new Error(`Unexpected fixture network request: ${request.url}`);
    // The check itself is a read; every other mutating method is a product dispatch.
    if (mutating.has(request.method) && !new URL(request.url).pathname.startsWith("/api/maps/look")) counts.dispatches += 1;
    return dispatchAssistantTestRoute(request);
  });
  const file = path.join(dir, "pts.geojson");
  await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { n: 1 }, geometry: { type: "Point", coordinates: [13.4, 52.5] } }] }));
  table = (await ingestFile(file, "pts.geojson")).name;
  mapId = createMap("Auto").id;
  layerId = (await createLayer(mapId, { name: "Points", sql: `SELECT * FROM ${table}` })).id;
  const driver: RenderDriver = { launch: async () => ({ render: async (input) => {
    counts.renders += 1; counts.appearances.push(input.definition.appearance); counts.namesAtRender.push(mapWithLayers(mapId).name);
    return { png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [{ id: layerId, filters: [] }], legend: { visible: true, corner: "bottom-left", order: [layerId] }, widgets: [], attribution: "", failures: [] }) };
  }, close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const builder = (extra: Partial<Extract<AssistantContext, { page: "builder" }>> = {}): AssistantContext => ({ page: "builder", mapId, selectedLayerId: null, ...extra });
const reply = (text: string, ...toolCalls: { id: string; name: string; args: Record<string, unknown> }[]): ProviderReply => ({ text, toolCalls });
let seq = 0;
const call = (name: string, args: Record<string, unknown>) => ({ id: `c${++seq}`, name, args });
async function collect(gen: AsyncGenerator<AssistantEvent>): Promise<{ events: AssistantEvent[]; threw?: unknown }> {
  const events: AssistantEvent[] = [];
  try { for await (const event of gen) events.push(event); } catch (threw) { return { events, threw }; }
  return { events };
}
/** The provider requests the stub answered: the send, every outcome continuation and every image continuation. */
const requests = (stub: ReturnType<typeof stubProvider>) => stub.recording.exchanges.reduce((n, e) => n + 1 + e.outcomes.length + (e.images?.length ?? 0), 0);
const checks = (events: AssistantEvent[]) => events.filter((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result" && e.tool === "look_at_map");
const automatic = (events: AssistantEvent[]) => checks(events).filter((e) => e.automatic === true);
const done = (events: AssistantEvent[]) => events.find((e): e is Extract<AssistantEvent, { type: "done" }> => e.type === "done");
function run(script: ScriptEntry[], context: AssistantContext | undefined, deps: Partial<LoopDeps> = {}) {
  const stub = stubProvider(script);
  const store = new PendingActionStore();
  const loop: LoopDeps = { baseUrl: origin, fetchImpl: instanceFetch(origin, requireRequestAuth(authenticatedRequest())), pending: store, stepBudget: 8, ...deps };
  return { stub, store, loop, start: (message = "go") => collect(runAssistant(stub, { message, history: [], context }, loop)) };
}

describe("2a and 7: one automatic check on a qualifying turn, none on a read-only turn, none with the setting off", () => {
  it("a map-changing turn schedules one check: one render, one added request, the observation ending the turn", async () => {
    const { stub, start } = run([reply("", call("update_map", { id: mapId, name: "Renamed" })), reply("Renamed it."), reply("The map shows one point.")], builder());
    const { events } = await start();
    expect(counts.renders).toBe(1);
    expect(automatic(events)).toHaveLength(1);
    expect(automatic(events)[0].ok).toBe(true);
    expect(automatic(events)[0].render).toMatchObject({ mapId, image: { width: 1024, height: 640 } });
    expect(requests(stub)).toBe(3);
    expect(stub.recording.exchanges[0].images).toHaveLength(1);
    expect(done(events)?.reason).toBe("end");
    expect(events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text)).toEqual(["Renamed it.", "The map shows one point."]);
    // The check comes after the answer's actions, in order.
    const order = events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool);
    expect(order).toEqual(["update_map", "look_at_map"]);
  });
  it("a read-only turn schedules nothing: zero renders, zero added requests", async () => {
    const { stub, start } = run([reply("", call("list_layers", { id: mapId })), reply("One layer.")], builder());
    const { events } = await start();
    expect(counts.renders).toBe(0);
    expect(checks(events)).toHaveLength(0);
    expect(requests(stub)).toBe(2);
    expect(done(events)?.reason).toBe("end");
  });
  it("with the setting off a qualifying turn schedules nothing and the answer is otherwise unchanged", async () => {
    const { stub, start } = run([reply("", call("update_map", { id: mapId, name: "Renamed" })), reply("Renamed it.")], builder(), { autoCheck: false });
    const { events } = await start();
    expect(counts.renders).toBe(0);
    expect(checks(events)).toHaveLength(0);
    expect(requests(stub)).toBe(2);
    expect(events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text)).toEqual(["Renamed it."]);
  });
  it("with the setting off an explicit check still runs", async () => {
    const { start } = run([reply("", call("look_at_map", { mapId })), reply("Seen.")], builder(), { autoCheck: false });
    const { events } = await start();
    expect(counts.renders).toBe(1);
    expect(checks(events)).toHaveLength(1);
    expect(automatic(events)).toHaveLength(0);
  });
  it("the automatic check renders with the context's appearance, light when it carries none", async () => {
    await run([reply("", call("update_map", { id: mapId, name: "A" })), reply("Done."), reply("Seen.")], builder()).start();
    await run([reply("", call("update_map", { id: mapId, name: "B" })), reply("Done."), reply("Seen.")], builder({ appearance: "dark" })).start();
    expect(counts.appearances).toEqual(["light", "dark"]);
  });
  it("the contextual map is supplied to a model-requested check that names none", async () => {
    const { events } = await run([reply("", call("look_at_map", {})), reply("Seen.")], builder()).start();
    expect(checks(events)[0].ok).toBe(true);
    expect(checks(events)[0].render?.mapId).toBe(mapId);
    expect(counts.renders).toBe(1);
  });
});

describe("once per turn, from the state after the last change", () => {
  it("two mutation batches schedule one check, rendered after the last change", async () => {
    const { start } = run([reply("", call("update_map", { id: mapId, name: "First" })), reply("", call("update_map", { id: mapId, name: "Final" })), reply("Both done."), reply("Seen.")], builder());
    const { events } = await start();
    expect(automatic(events)).toHaveLength(1);
    expect(counts.renders).toBe(1);
    expect(counts.namesAtRender).toEqual(["Final"]);
  });
  it("a check taken before the last mutation is not reused: the turn renders again", async () => {
    const { start } = run([reply("", call("look_at_map", { mapId })), reply("", call("update_map", { id: mapId, name: "After the look" })), reply("Changed."), reply("Seen again.")], builder());
    const { events } = await start();
    expect(checks(events)).toHaveLength(2);
    expect(automatic(events)).toHaveLength(1);
    expect(counts.renders).toBe(2);
    expect(counts.namesAtRender).toEqual(["Auto", "After the look"]);
  });
  it("a model-requested check of the final state leaves nothing to schedule", async () => {
    const { start } = run([reply("", call("update_map", { id: mapId, name: "Then looked" })), reply("", call("look_at_map", { mapId })), reply("Looked.")], builder());
    const { events } = await start();
    expect(checks(events)).toHaveLength(1);
    expect(automatic(events)).toHaveLength(0);
    expect(counts.renders).toBe(1);
  });
});

describe("2c and 1l across a confirmation", () => {
  it("nothing is scheduled at the park, a change already landed; the check follows the settled continuation", async () => {
    // A change lands before the gate, so a decision consulted at the park would have something to
    // schedule.
    const { store, loop, start } = run([reply("", call("update_map", { id: mapId, name: "Before the gate" }), call("delete_layer", { id: layerId })), reply("Deleted."), reply("Seen.")], builder(), { stepBudget: 5 });
    const parked = await start();
    expect(parked.events.some((e) => e.type === "confirm_required")).toBe(true);
    expect(parked.events.some((e) => e.type === "tool_result" && e.tool === "update_map" && e.ok)).toBe(true);
    expect(counts.renders).toBe(0);
    expect(automatic(parked.events)).toHaveLength(0);
    const pending = parked.events.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const resumed = await collect(resumeAssistant(store.claim(pending.id, "approved")!, true, loop));
    expect(counts.renders).toBe(1);
    expect(automatic(resumed.events)).toHaveLength(1);
    expect(done(resumed.events)?.reason).toBe("end");
  });
  it("across a confirmation at the last step no check is scheduled, the turn ending normally", async () => {
    const { store, loop, start } = run([reply("", call("delete_layer", { id: layerId })), reply("Deleted.")], builder(), { stepBudget: 2 });
    const parked = await start();
    const pending = parked.events.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const resumed = await collect(resumeAssistant(store.claim(pending.id, "approved")!, true, loop));
    expect(counts.renders).toBe(0);
    expect(automatic(resumed.events)).toHaveLength(0);
    expect(done(resumed.events)?.reason).toBe("end");
  });
  it("a model-requested check across a confirmation that spends the last step keeps its outcome and admits no further request", async () => {
    const { stub, store, loop, start } = run([reply("", call("delete_layer", { id: layerId })), reply("", call("look_at_map", { mapId })), reply("never asked")], builder(), { stepBudget: 2 });
    const parked = await start();
    const pending = parked.events.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const resumed = await collect(resumeAssistant(store.claim(pending.id, "approved")!, true, loop));
    expect(checks(resumed.events)[0].ok).toBe(true);
    expect(checks(resumed.events)[0].render).toBeDefined();
    expect(done(resumed.events)?.reason).toBe("budget");
    expect(requests(stub)).toBe(2);
    expect(counts.renders).toBe(1);
  });
});

describe("1l before a confirmation: the budget boundary", () => {
  it("an automatic check is not scheduled when its step would be the last; it is when one remains", async () => {
    const script = () => [reply("", call("update_map", { id: mapId, name: "One" })), reply("", call("update_map", { id: mapId, name: "Two" })), reply("Done."), reply("Seen.")];
    const tight = await run(script(), builder(), { stepBudget: 3 }).start();
    expect(counts.renders).toBe(0);
    expect(automatic(tight.events)).toHaveLength(0);
    expect(done(tight.events)?.reason).toBe("end");
    const roomy = await run(script(), builder(), { stepBudget: 4 }).start();
    expect(counts.renders).toBe(1);
    expect(automatic(roomy.events)).toHaveLength(1);
  });
  it("a model-requested check that spends the last step keeps its render outcome and admits no further provider call", async () => {
    const { stub, start } = run([reply("", call("update_map", { id: mapId, name: "X" })), reply("", call("look_at_map", { mapId })), reply("never asked")], builder(), { stepBudget: 2 });
    const { events } = await start();
    expect(checks(events)[0].ok).toBe(true);
    expect(checks(events)[0].render).toBeDefined();
    expect(done(events)?.reason).toBe("budget");
    expect(requests(stub)).toBe(2);
    expect(counts.renders).toBe(1);
  });
});

describe("nothing after cancellation, a terminal provider error, a terminal action failure or exhaustion; the earlier record survives", () => {
  const earlierThen = (...rest: ScriptEntry[]) => [reply("", call("look_at_map", { mapId })), reply("", call("update_map", { id: mapId, name: "Changed" })), ...rest];
  const survives = (events: AssistantEvent[]) => { const first = checks(events)[0]; expect(first?.ok).toBe(true); expect(first?.render).toBeDefined(); };
  it("after cancellation", async () => {
    const controller = new AbortController();
    const seen = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.method === "PATCH") controller.abort(new DOMException("Execution departed", "AbortError"));
      return seen(request);
    });
    const { stub, start } = run(earlierThen(reply("Changed."), reply("never")), builder(), { signal: controller.signal });
    const { events } = await start();
    survives(events);
    expect(done(events)?.reason).toBe("interrupted");
    expect(counts.renders).toBe(1);
    expect(automatic(events)).toHaveLength(0);
    expect(requests(stub)).toBe(2);
  });
  it("after a terminal provider error", async () => {
    const { start } = run(earlierThen(() => { throw new ProviderError("The model provider request failed (503).", "provider"); }), builder());
    const { events } = await start();
    survives(events);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(counts.renders).toBe(1);
    expect(automatic(events)).toHaveLength(0);
  });
  it("after a terminal action failure", async () => {
    const seen = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.method === "PATCH") throw new TypeError("fetch failed");
      return seen(request);
    });
    const { start } = run(earlierThen(reply("never")), builder());
    const { events, threw } = await start();
    survives(events);
    expect(threw).toBeDefined();
    expect(events.some((e) => e.type === "tool_result" && e.outcome === "uncertain")).toBe(true);
    expect(counts.renders).toBe(1);
    expect(automatic(events)).toHaveLength(0);
  });
  it("after exhaustion", async () => {
    const { stub, start } = run(earlierThen(reply("never")), builder(), { stepBudget: 2 });
    const { events } = await start();
    survives(events);
    expect(done(events)?.reason).toBe("budget");
    expect(counts.renders).toBe(1);
    expect(automatic(events)).toHaveLength(0);
    expect(requests(stub)).toBe(2);
  });
});

describe("2f and 2f.i: the map in context", () => {
  it("a contextless, mutation-admitted run schedules nothing", async () => {
    const { stub, start } = run([reply("", call("update_map", { id: mapId, name: "No context" })), reply("Done.")], undefined);
    const { events } = await start();
    expect(events.some((e) => e.type === "tool_result" && e.tool === "update_map" && e.ok)).toBe(true);
    expect(counts.renders).toBe(0);
    expect(automatic(events)).toHaveLength(0);
    expect(requests(stub)).toBe(2);
  });
  for (const context of [
    { page: "sql", draft: "", selection: null, lastExecution: null } as AssistantContext,
    { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null } as AssistantContext,
  ]) it(`${context.page}: the mutation is refused and nothing is scheduled, while an explicit check succeeds`, async () => {
    const { start } = run([reply("", call("update_map", { id: mapId, name: "Refused" }), call("look_at_map", { mapId })), reply("Done.")], context);
    const { events } = await start();
    const refused = events.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result" && e.tool === "update_map")!;
    expect(refused.ok).toBe(false);
    expect((refused.body as { error: { code: string } }).error.code).toBe("assistant_action_not_admitted");
    expect(checks(events)[0].ok).toBe(true);
    expect(automatic(events)).toHaveLength(0);
    expect(counts.renders).toBe(1);
    expect(mapWithLayers(mapId).name).toBe("Auto");
  });
});

describe("the observation ends the turn", () => {
  for (const [what, proposal] of [["another mutation", call("update_map", { id: mapId, name: "Proposed" })], ["another check", call("look_at_map", { mapId })]] as const) {
    it(`an observation proposing ${what} dispatches nothing and the turn settles`, async () => {
      const { stub, start } = run([reply("", call("update_map", { id: mapId, name: "Changed" })), reply("Changed."), reply("I would change it.", proposal)], builder());
      const before = counts.dispatches;
      const { events } = await start();
      expect(done(events)?.reason).toBe("end");
      expect(counts.renders).toBe(1);
      expect(counts.dispatches - before).toBe(1);
      expect(requests(stub)).toBe(3);
      expect(mapWithLayers(mapId).name).toBe("Changed");
      expect(events.filter((e) => e.type === "tool_call")).toHaveLength(2);
    });
  }
});

describe("scheduling facts are the contextual map's", () => {
  it("an explicit look at another map does not clear the contextual map's pending check", async () => {
    const other = createMap("Other").id;
    const { start } = run([reply("", call("update_map", { id: mapId, name: "Changed" })), reply("", call("look_at_map", { mapId: other })), reply("Looked elsewhere."), reply("Seen.")], builder());
    const { events } = await start();
    // Seeded defect on the shipped rule: the look at the other map cleared mutatedSince, so the
    // contextual map was never checked.
    expect(checks(events)).toHaveLength(2);
    expect(automatic(events)).toHaveLength(1);
    expect(automatic(events)[0].render?.mapId).toBe(mapId);
  });
  it("a layer change on another map schedules no picture of the unchanged contextual map", async () => {
    const other = createMap("Other").id;
    const otherLayer = (await createLayer(other, { name: "Elsewhere", sql: `SELECT * FROM ${table}` })).id;
    const { start } = run([reply("", call("update_layer", { id: otherLayer, name: "Renamed elsewhere" })), reply("Renamed the other map's layer.")], builder());
    const { events } = await start();
    expect(events.some((e) => e.type === "tool_result" && e.tool === "update_layer" && e.ok)).toBe(true);
    expect(automatic(events)).toHaveLength(0);
    expect(counts.renders).toBe(0);
  });
});

describe("every successful check in a batch awaits the observation", () => {
  it("two looks in one batch both receive the subsequent sentence", async () => {
    const other = createMap("Other").id;
    const { start } = run([reply("", call("look_at_map", { mapId }), call("look_at_map", { mapId: other })), reply("Both maps are nearly empty. One point each.")], builder());
    const { events } = await start();
    const observations = events.filter((e): e is Extract<AssistantEvent, { type: "observation" }> => e.type === "observation");
    expect(checks(events)).toHaveLength(2);
    expect(observations.map((o) => [o.id, o.state, o.text])).toEqual(checks(events).map((c) => [c.id, "captured", "Both maps are nearly empty."]));
  });
});

describe("a look before a gated call parks by its true size", () => {
  it("a 250 KiB image in the batch's outcomes does not trip the live-state bound at the park", async () => {
    let seed = 0x2545f491;
    const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 24) & 0xff; };
    const big = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).map((_, i) => (i % 4 === 3 ? 255 : i < 1024 * 640 * 4 * 0.13 ? rand() : 240)) });
    expect(big.byteLength).toBeGreaterThan(200 * 1024);
    setLookDriverForTests({ launch: async () => ({ render: async () => ({ png: big, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }) });
    const { start } = run([reply("", call("look_at_map", { mapId }), call("delete_layer", { id: layerId })), reply("Deleted.")], builder());
    const { events } = await start();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "confirm_required")).toBe(true);
    expect(checks(events)[0].ok).toBe(true);
  });
});

describe("a write that names another map is not the contextual map's change", () => {
  type Result = Extract<AssistantEvent, { type: "tool_result" }>;
  const write = (maps: string[], layersToo: boolean): Result => ({
    type: "tool_result", id: "w", tool: "duplicate_map", ok: true, body: {}, outcome: "succeeded",
    effects: { readOnly: false, writes: [{ resource: "maps", ids: maps, collection: maps.length === 0 }, ...(layersToo ? [{ resource: "layers" as const, ids: [], collection: true }] : [])] },
  });
  it("qualifyingChange honors a specific map identity before the broad layer fallback", () => {
    // Seeded defect on the shipped rule: the unconditional layer branch qualified a copy's layers
    // as the contextual map's change.
    expect(qualifyingChange(write(["copy"], true), mapId)).toBe(false);
    expect(qualifyingChange(write([mapId], true), mapId)).toBe(true);
    expect(qualifyingChange(write([], true), mapId)).toBe(true);
    expect(qualifyingChange(write(["copy"], true), undefined)).toBe(true);
  });
  it("duplicating the contextual map schedules no picture of the unchanged original", async () => {
    const { start } = run([reply("", call("duplicate_map", { id: mapId })), reply("Duplicated it.")], builder());
    const { events } = await start();
    expect(events.some((e) => e.type === "tool_result" && e.tool === "duplicate_map" && e.ok)).toBe(true);
    expect(automatic(events)).toHaveLength(0);
    expect(counts.renders).toBe(0);
  });
});
