import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import type { AssistantContext } from "./context";
import type { AssistantEvent } from "./loop";
import type { ModelProvider } from "./provider";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { dispatchObserver, providerObserver } from "./testing/observer";

/**
 * No-replay is a count: after a dropped stream, a lost approval
 * response, an uncertain outcome and an evicted run, the documented
 * recovery reads report what happened and start nothing. The resource is
 * read independently and stays at its one change; the observer counts
 * zero further assistant-originated dispatches and zero further provider
 * calls, apart from the test's own reads, which never pass through the
 * loop's fetch.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://localhost:3205";
let dir: string;
let observer: ReturnType<typeof dispatchObserver>;
/** A route the test can hold or break: the next PATCH's response is withheld until released, or lost after the change landed. */
let holdPatch: { promise: Promise<void>; release: () => void } | null = null;
let losePatch = false;

beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-noreplay-test-"));
  // The automatic map check has its own suites; this one counts its turns'
  // exact dispatches. Without the stub its sibling suites carry, the two cases
  // whose turn ends after a succeeded mutation launch the real headless browser
  // through the check, inside a budget equal to the test bound.
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3205");
  closeMetadataDb(); resetQueryInstance(); holdPatch = null; losePatch = false;
  observer = dispatchObserver(async (request) => {
    if (holdPatch && request.method === "PATCH") { const hold = holdPatch; holdPatch = null; await hold.promise; }
    if (losePatch && request.method === "PATCH") { losePatch = false; await dispatchAssistantTestRoute(request); throw new TypeError("The response was lost after the change landed"); }
    return dispatchAssistantTestRoute(request);
  }, new Set([origin, "http://127.0.0.1:3205"]));
  vi.stubGlobal("fetch", observer.fetchImpl);
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A verification read or write: straight to the routes, never through the loop's fetch. */
const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function events(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function provider(script: ScriptEntry[]) {
  const observed = providerObserver(stubProvider(script));
  factory.provider = observed;
  return observed;
}
async function reserve() { return (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string; }
async function seed() {
  const csv = path.join(dir, "facts.csv"); await writeFile(csv, "city,lon,lat,value\nBerlin,13.4,52.5,4\n");
  await ingestFile(testAccountScope(), csv, "facts.csv");
  const map = createMap(testAccountScope(), "Original map");
  return { map, builder: { page: "builder", mapId: map.id, selectedLayerId: null } as AssistantContext };
}
const mapName = async (id: string) => ((await (await api(`/api/maps/${id}`)).json()) as { name: string }).name;
const receiptOf = async (runId: string) => (await (await api(`/api/assistant/runs/${runId}`)).json()) as { state: string; actions: { tool: string; status: string; label?: string }[]; pending?: { id: string } };
const patches = (mapId: string) => observer.dispatches.filter((d) => d.method === "PATCH" && d.path === `/api/maps/${mapId}`);
/** The recovery reads every case makes: the run twice, the pending list, the map. */
async function recoverAndVerify(runId: string, mapId: string) {
  const before = { dispatches: observer.dispatches.length, calls: (factory.provider as ReturnType<typeof providerObserver>).calls() };
  const first = await receiptOf(runId); const second = await receiptOf(runId);
  await api("/api/assistant/pending");
  const name = await mapName(mapId);
  expect(second).toEqual(first);
  expect(observer.dispatches.length - before.dispatches, "assistant-originated dispatches after recovery").toBe(0);
  expect((factory.provider as ReturnType<typeof providerObserver>).calls() - before.calls, "provider calls after recovery").toBe(0);
  return { receipt: first, name };
}

describe("a dropped stream", () => {
  it("recovers the rename once, with zero further dispatches and provider calls", async () => {
    const { map, builder } = await seed();
    const held = { promise: null as unknown as Promise<void>, release: () => {} };
    held.promise = new Promise<void>((resolve) => { held.release = resolve; });
    holdPatch = held;
    const p = provider([
      { text: "", toolCalls: [{ id: "rename-dropped", name: "update_map", args: { id: map.id, name: "Renamed once" } }] },
      { text: "Done", toolCalls: [] },
    ]);
    const runId = await reserve();
    const controller = new AbortController();
    // The request stays referenced until the abort: undici follows an init
    // signal through a weakly held listener, and a collected Request drops
    // it, which made this case flake before the reference was kept.
    const request = new Request(origin + "/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Rename", context: builder }), signal: controller.signal });
    const response = await dispatchAssistantTestRoute(request);
    expect(response.status).toBe(200);
    // The rename is in flight when the client departs; its response then lands on the server alone.
    await vi.waitFor(() => expect(patches(map.id)).toHaveLength(1));
    controller.abort(new DOMException("departed", "AbortError"));
    expect(request.signal.aborted).toBe(true);
    held.release();
    const drained = (await response.text()).trim().split("\n").map((l) => (JSON.parse(l) as AssistantEvent).type);
    expect(drained).toEqual(["tool_call", "tool_result", "done"]);
    await vi.waitFor(async () => expect((await receiptOf(runId)).state).not.toBe("running"));
    const { receipt, name } = await recoverAndVerify(runId, map.id);
    expect(receipt.state).toBe("interrupted");
    expect(name).toBe("Renamed once");
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "update_map", status: "succeeded", label: "Updated the map Renamed once" })]);
    expect(patches(map.id)).toHaveLength(1);
    expect(p.calls()).toBe(1);
  });
});

describe("a lost approval response", () => {
  it("executes the approved publish once, recovers it, and a repeated resolution performs nothing", async () => {
    const { map, builder } = await seed();
    const p = provider([
      { text: "", toolCalls: [{ id: "publish-lost", name: "publish_map", args: { id: map.id } }] },
      { text: "Published", toolCalls: [] },
    ]);
    const runId = await reserve();
    const parked = await events(await api("/api/assistant/messages", { runId, message: "Publish", context: builder }));
    const pending = parked.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const controller = new AbortController();
    const request = new Request(origin + "/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: { pending: pending.id, approved: true } }), signal: controller.signal });
    const response = await dispatchAssistantTestRoute(request);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(observer.dispatches.filter((d) => d.path.endsWith("/publish"))).toHaveLength(1));
    controller.abort(new DOMException("departed", "AbortError"));
    expect(request.signal.aborted).toBe(true);
    await response.text();
    await vi.waitFor(async () => expect((await receiptOf(runId)).state).not.toBe("running"));
    const { receipt } = await recoverAndVerify(runId, map.id);
    expect(receipt.actions.find((a) => a.tool === "publish_map")).toMatchObject({ status: "succeeded" });
    expect(((await (await api(`/api/maps/${map.id}`)).json()) as { publishToken: string | null }).publishToken).toEqual(expect.any(String));
    // A repeated resolution performs nothing and answers the documented error.
    const repeat = await api("/api/assistant/messages", { resolution: { pending: pending.id, approved: true } });
    expect(repeat.status).toBe(409);
    expect(((await repeat.json()) as { error: { code: string } }).error.code).toBe("pending_resolved");
    expect(observer.dispatches.filter((d) => d.path.endsWith("/publish"))).toHaveLength(1);
    expect(p.calls()).toBe(2);
  });
});

describe("an uncertain outcome and an unavailable run", () => {
  it("a mutation whose response is lost after the change landed recovers as uncertain and is never re-executed", async () => {
    const { map, builder } = await seed();
    losePatch = true;
    provider([{ text: "", toolCalls: [{ id: "rename-uncertain", name: "update_map", args: { id: map.id, name: "Maybe renamed" } }] }, { text: "Done", toolCalls: [] }]);
    const runId = await reserve();
    const drained = (await (await api("/api/assistant/messages", { runId, message: "Rename", context: builder })).text()).trim().split("\n").map((l) => JSON.parse(l) as AssistantEvent);
    const result = drained.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(result.outcome).toBe("uncertain");
    const { receipt, name } = await recoverAndVerify(runId, map.id);
    // The change landed, the record says uncertain, and nothing runs it again.
    expect(name).toBe("Maybe renamed");
    expect(receipt.state).toBe("failed");
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "update_map", status: "uncertain" })]);
    expect(patches(map.id)).toHaveLength(1);
  });
  it("an evicted or pre-restart run stays unavailable and starts nothing", async () => {
    const { map, builder } = await seed();
    provider([{ text: "", toolCalls: [{ id: "rename-restart", name: "update_map", args: { id: map.id, name: "Before restart" } }] }, { text: "Done", toolCalls: [] }]);
    const runId = await reserve();
    await events(await api("/api/assistant/messages", { runId, message: "Rename", context: builder }));
    expect(await mapName(map.id)).toBe("Before restart");
    // The process restarts: working state is gone.
    assistantRuns.resetForTests(); pendingActions.resetForTests();
    const before = observer.dispatches.length;
    const read = await api(`/api/assistant/runs/${runId}`);
    expect(read.status).toBe(404);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe("assistant_run_unavailable");
    const resolution = await api("/api/assistant/messages", { resolution: { pending: "gone", approved: true } });
    expect(resolution.status).toBe(404);
    expect(observer.dispatches.length).toBe(before);
    expect(await mapName(map.id)).toBe("Before restart");
    expect(patches(map.id)).toHaveLength(1);
  });
});

describe("the seeded replay: the count's control", () => {
  it("a recovery read that replays the rename leaves the expected name; only the count reports it", async () => {
    const { map, builder } = await seed();
    provider([{ text: "", toolCalls: [{ id: "rename-control", name: "update_map", args: { id: map.id, name: "Renamed once" } }] }, { text: "Done", toolCalls: [] }]);
    const runId = await reserve();
    await events(await api("/api/assistant/messages", { runId, message: "Rename", context: builder }));
    const rename = patches(map.id)[0];
    const replayingRead = async () => { const receipt = await receiptOf(runId); await fetch(rename.request.clone()); return receipt; };
    await replayingRead();
    // State alone passes under the seed; the count does not.
    expect(await mapName(map.id)).toBe("Renamed once");
    expect(patches(map.id)).toHaveLength(2);
  });
});
