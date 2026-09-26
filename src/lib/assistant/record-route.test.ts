import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { recoveredTurn } from "@/components/builder/assistant/assistant-turn-state";
import { resumeAssistant } from "./loop";
import type { RunReceipt } from "./runs";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { createLayer } from "@/lib/layer-service";
import { metadataDb } from "@/lib/metadata/db";
import type { AssistantContext } from "./context";
import type { AssistantEvent } from "./loop";
import type { ModelProvider } from "./provider";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The retained record through the real routes. Two of task 1's reds live
 * here: a resolution deletes the decision it settled, so the record
 * cannot say afterwards whether a gate was approved, declined or
 * superseded; and resource state alone passes a replayed idempotent
 * update, so a recovery that repeated a rename would leave exactly the
 * expected name (2b to 2e, D8).
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://localhost:3203";
const origins = new Set([origin, "http://127.0.0.1:3203"]);
let dir: string;
/** Every product request the loop dispatched through the stubbed fetch,
 * with the time its response took: the execution window measured outside
 * the loop. */
let dispatched: { method: string; path: string; request: Request; tookMs: number }[];

beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-record-test-"));
  // The automatic map check has its own suites; this one asserts its turns' exact actions.
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3203");
  closeMetadataDb(); resetQueryInstance(); dispatched = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!origins.has(url.origin)) throw new Error(`Unexpected fixture network request: ${request.url}`);
    const entry = { method: request.method, path: url.pathname, request: request.clone(), tookMs: 0 };
    dispatched.push(entry);
    const started = performance.now();
    return dispatchAssistantTestRoute(request).finally(() => { entry.tookMs = performance.now() - started; });
  });
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A verification read or write by the test itself, never through the loop's fetch. */
const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function events(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
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
  await ingestFile(csv, "facts.csv");
  const map = createMap("Original map");
  return { map, builder: { page: "builder", mapId: map.id, selectedLayerId: null } as AssistantContext };
}
const mapName = async (id: string) => ((await (await api(`/api/maps/${id}`)).json()) as { name: string }).name;
type Result = Extract<AssistantEvent, { type: "tool_result" }>;
const results = (stream: AssistantEvent[]) => stream.filter((e): e is Result => e.type === "tool_result");
const storedSteps = (group: string) => metadataDb().prepare("SELECT map_id AS mapId, group_id AS groupId, scope, op FROM map_history WHERE group_id = ? ORDER BY seq").all(group) as { mapId: string; groupId: string; scope: string; op: string }[];
const receiptOf = async (runId: string) => (await (await api(`/api/assistant/runs/${runId}`)).json()) as Record<string, unknown>;

describe("a settled decision stays in the record", () => {
  it("after approval the recovery read still says the gate was approved", async () => {
    const { map, builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "publish-gated", name: "publish_map", args: { id: map.id } }] },
      { text: "Published", toolCalls: [] },
    ], builder, "Publish the map");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required");
    expect(pending?.tool).toBe("publish_map");
    await events(await api("/api/assistant/messages", { resolution: { pending: pending!.id, approved: true } }));
    const receipt = await receiptOf(runId);
    expect(receipt.state).toBe("completed");
    // Seeded defect: resuming the run deletes its pending representation
    // and records nothing in its place, so the settled decision is gone.
    expect(receipt.confirmations).toEqual([expect.objectContaining({ id: pending!.id, tool: "publish_map", decision: "approved" })]);
  });
});

describe("2b to 2e, D8: no-replay is a count, never resource state", () => {
  // Task 1's red, now the count's control (task 10): the observer in
  // no-replay-route.test.ts counts every recovery case; here the seeded
  // replay shows what resource state hides and the count reports.
  it("control: a replayed idempotent rename leaves the expected name; the count alone reports the second dispatch", async () => {
    const { map, builder } = await seed();
    await turn([
      { text: "", toolCalls: [{ id: "rename-once", name: "update_map", args: { id: map.id, name: "Renamed once" } }] },
      { text: "Done", toolCalls: [] },
    ], builder, "Rename the map");
    const rename = dispatched.find((d) => d.method === "PATCH" && d.path === `/api/maps/${map.id}`)!;
    await fetch(rename.request.clone());
    expect(await mapName(map.id)).toBe("Renamed once");
    expect(dispatched.filter((d) => d.method === "PATCH" && d.path === `/api/maps/${map.id}`)).toHaveLength(2);
  });
});

describe("elapsed time is the dispatch alone, never the gate's wait", () => {
  it("an approved publish held 400 ms at its gate records an elapsed time inside its own dispatch window", async () => {
    const { map, builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "publish-held", name: "publish_map", args: { id: map.id } }] },
      { text: "Published", toolCalls: [] },
    ], builder, "Publish the map");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const resolved = await events(await api("/api/assistant/messages", { resolution: { pending: pending.id, approved: true } }));
    const publish = results(resolved).find((r) => r.tool === "publish_map")!;
    const window = dispatched.find((d) => d.method === "POST" && d.path === `/api/maps/${map.id}/publish`)!;
    expect(publish.ok).toBe(true);
    expect(publish.decision).toBe("approved");
    expect(publish.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(publish.elapsedMs).toBeLessThanOrEqual(Math.ceil(window.tookMs) + 25);
    expect(publish.elapsedMs).toBeLessThan(300);
    const receipt = await receiptOf(runId);
    expect((receipt.actions as { tool: string; elapsedMs?: number; decision?: string }[]).find((a) => a.tool === "publish_map")).toMatchObject({ elapsedMs: publish.elapsedMs, decision: "approved" });
  });
});

describe("the recorded map and change group match the stored history steps", () => {
  it("two maps in one turn share the group; an excluded mutation exposes neither; a no-op update writes no step", async () => {
    const { map, builder } = await seed();
    const other = createMap("Other map");
    const layer = await createLayer(other.id, { name: "Facts", sql: "SELECT * FROM facts" });
    const { stream, runId } = await turn([
      { text: "", toolCalls: [
        { id: "rename-a", name: "update_map", args: { id: map.id, name: "A renamed" } },
        { id: "rename-b", name: "update_layer", args: { id: layer.id, name: "Facts renamed" } },
        { id: "create-c", name: "create_map", args: { name: "C" } },
        { id: "rename-a-again", name: "update_map", args: { id: map.id, name: "A renamed" } },
      ] },
      { text: "Done", toolCalls: [] },
    ], builder, "Rename things");
    const [a, b, c, again] = results(stream);
    expect([a.ok, b.ok, c.ok, again.ok]).toEqual([true, true, true, true]);
    const group = a.history?.group;
    expect(group).toEqual(expect.any(String));
    expect(a.history).toEqual({ mapId: map.id, group });
    expect(b.history).toEqual({ mapId: other.id, group });
    // Excluded from history: a map's creation writes no step, so the
    // record exposes neither map nor group for it and claims no undo.
    expect(c.history).toBeUndefined();
    expect(again.history).toEqual({ mapId: map.id, group });
    // Read from stored history, not the availability read: one step per
    // map for the turn, none for the no-op repeat.
    expect(storedSteps(group!)).toEqual([
      { mapId: map.id, groupId: group, scope: "map", op: "update" },
      { mapId: other.id, groupId: group, scope: "layer", op: "update" },
    ]);
    const receipt = await receiptOf(runId);
    expect((receipt.actions as { history?: unknown }[]).map((x) => x.history)).toEqual([a.history, b.history, undefined, again.history]);
    // The history read still answers availability only; the association above is the record's.
    expect(await (await api(`/api/maps/${map.id}/history`)).json()).toEqual({ canUndo: true, canRedo: false });
  });
});

describe("declined and superseded decisions stay in the record too", () => {
  it("a decline settles as declined on the refused result and in the receipt", async () => {
    const { map, builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "publish-declined", name: "publish_map", args: { id: map.id } }] },
      { text: "Kept unpublished", toolCalls: [] },
    ], builder, "Publish the map");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const resolved = await events(await api("/api/assistant/messages", { resolution: { pending: pending.id, approved: false } }));
    const refused = results(resolved).find((r) => r.tool === "publish_map")!;
    expect(refused).toMatchObject({ ok: false, outcome: "refused", decision: "declined" });
    expect(dispatched.filter((d) => d.path.endsWith("/publish"))).toEqual([]);
    const receipt = await receiptOf(runId);
    expect(receipt.pending).toBeUndefined();
    expect(receipt.confirmations).toEqual([expect.objectContaining({ id: pending.id, tool: "publish_map", decision: "declined", confirmation: pending.confirmation })]);
  });
  it("a newer message naming the pending action settles it as superseded on the parked run; a release does the same", async () => {
    const { map, builder } = await seed();
    const first = await turn([
      { text: "", toolCalls: [{ id: "publish-superseded", name: "publish_map", args: { id: map.id } }] },
    ], builder, "Publish the map");
    const pending = first.stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    factory.provider = stubProvider([{ text: "Moving on", toolCalls: [] }]);
    const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
    await events(await api("/api/assistant/messages", { runId, message: "Never mind", context: builder, supersedes: pending.id }));
    const parked = await receiptOf(first.runId);
    expect(parked.state).toBe("interrupted");
    expect(parked.confirmations).toEqual([expect.objectContaining({ id: pending.id, tool: "publish_map", decision: "superseded" })]);
    expect(dispatched.filter((d) => d.path.endsWith("/publish"))).toEqual([]);
    // A release of another parked turn settles its confirmation the same way.
    const second = await turn([
      { text: "", toolCalls: [{ id: "publish-released", name: "publish_map", args: { id: map.id } }] },
    ], builder, "Publish the map again");
    const released = await (await api(`/api/assistant/runs/${second.runId}`, undefined, "DELETE")).json() as Record<string, unknown>;
    expect(released.state).toBe("interrupted");
    expect(released.confirmations).toEqual([expect.objectContaining({ tool: "publish_map", decision: "superseded" })]);
  });
});

describe("the recorded subject and inputs", () => {
  it("a fill computation and a rename are inspectable through their retained inputs and words", async () => {
    const { map, builder } = await seed();
    const layer = await createLayer(map.id, { name: "Facts", sql: "SELECT * FROM facts" });
    const { stream, runId } = await turn([
      { text: "", toolCalls: [
        { id: "fill-1", name: "compute_fill", args: { id: layer.id, attribute: "value", method: "quantile", classes: 3 } },
        { id: "rename-1", name: "update_layer", args: { id: layer.id, name: "Facts renamed" } },
      ] },
      { text: "Done", toolCalls: [] },
    ], builder, "Colour and rename");
    const [fill, rename] = results(stream);
    expect(fill).toMatchObject({ ok: true, label: `Computed a quantile fill by value on the layer ${layer.id}`, subject: { resource: "layers", id: layer.id } });
    expect(rename).toMatchObject({ ok: true, label: "Updated the layer Facts renamed", subject: { resource: "layers", id: layer.id, name: "Facts renamed" } });
    const receipt = await receiptOf(runId);
    const actions = receipt.actions as { tool: string; args?: Record<string, unknown>; label?: string }[];
    // No SQL, but the retained inputs are exactly the call's own.
    expect(actions[0]).toMatchObject({ tool: "compute_fill", args: { id: layer.id, attribute: "value", method: "quantile", classes: 3 }, label: `Computed a quantile fill by value on the layer ${layer.id}` });
    expect(actions[1]).toMatchObject({ tool: "update_layer", args: { id: layer.id, name: "Facts renamed" } });
  });
  it("renaming the subject afterwards leaves the recorded subject unchanged", async () => {
    const { map, builder } = await seed();
    const layer = await createLayer(map.id, { name: "Facts", sql: "SELECT * FROM facts" });
    const { runId } = await turn([
      { text: "", toolCalls: [{ id: "read-1", name: "get_layer", args: { id: layer.id } }] },
      { text: "Done", toolCalls: [] },
    ], builder, "Look at the layer");
    expect((await receiptOf(runId)).actions).toEqual([expect.objectContaining({ label: "Read the layer Facts", subject: { resource: "layers", id: layer.id, name: "Facts" } })]);
    await api(`/api/layers/${layer.id}`, { name: "Later name" }, "PATCH");
    expect(((await (await api(`/api/layers/${layer.id}`)).json()) as { name: string }).name).toBe("Later name");
    expect((await receiptOf(runId)).actions).toEqual([expect.objectContaining({ label: "Read the layer Facts", subject: { resource: "layers", id: layer.id, name: "Facts" } })]);
  });
  it("an unknown operation's call is refused honestly, with no fabricated subject or words", async () => {
    const { builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "unknown-1", name: "teleport_map", args: { id: "somewhere" } }] },
      { text: "Done", toolCalls: [] },
    ], builder, "Teleport");
    const [refused] = results(stream);
    expect(refused).toMatchObject({ tool: "teleport_map", ok: false, outcome: "refused", body: { error: { code: "invalid_request", message: "Unknown tool: teleport_map" } } });
    expect(refused.label).toBeUndefined();
    expect(refused.subject).toBeUndefined();
    expect(dispatched.filter((d) => d.method !== "GET")).toEqual([]);
    expect((await receiptOf(runId)).actions).toEqual([expect.objectContaining({ tool: "teleport_map", status: "refused" })]);
  });
});

describe("a manual edit during the pause splits the turn's steps", () => {
  it("the record shows the turn's actions in order; undo and redo move the map through the split the boundary predicts", async () => {
    const { map, builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [
        { id: "first", name: "update_map", args: { id: map.id, name: "First" } },
        { id: "publish-pause", name: "publish_map", args: { id: map.id } },
      ] },
      { text: "", toolCalls: [{ id: "second", name: "update_map", args: { id: map.id, name: "Second" } }] },
      { text: "Done", toolCalls: [] },
    ], builder, "Rename, publish, rename");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    expect(await mapName(map.id)).toBe("First");
    // The manual edit lands while the turn waits at its gate: no group.
    await api(`/api/maps/${map.id}`, { name: "Manual" }, "PATCH");
    const resumed = await events(await api("/api/assistant/messages", { resolution: { pending: pending.id, approved: true } }));
    expect(results(resumed).map((r) => [r.tool, r.ok])).toEqual([["publish_map", true], ["update_map", true]]);
    expect(await mapName(map.id)).toBe("Second");
    const receipt = await receiptOf(runId);
    const actions = receipt.actions as { tool: string; label?: string; history?: { group: string } }[];
    expect(actions.map((a) => a.label)).toEqual(["Updated the map First", `Published the map ${map.id}`, "Updated the map Second"]);
    const group = actions[0].history!.group;
    expect(actions[2].history!.group).toBe(group);
    // Stored history: the turn's two steps around the manual one, which carries no group.
    const steps = metadataDb().prepare("SELECT group_id AS groupId, after FROM map_history WHERE map_id = ? ORDER BY seq").all(map.id) as { groupId: string | null; after: string }[];
    expect(steps.map((step) => [step.groupId, (JSON.parse(step.after) as { name: string }).name])).toEqual([[group, "First"], [null, "Manual"], [group, "Second"]]);
    // boundary through the documented undo and redo, the map read after each.
    const undo = async () => { await api(`/api/maps/${map.id}/undo`, {}, "POST"); return mapName(map.id); };
    const redo = async () => { await api(`/api/maps/${map.id}/redo`, {}, "POST"); return mapName(map.id); };
    expect(await undo()).toBe("Manual");
    expect(await undo()).toBe("First");
    expect(await undo()).toBe("Original map");
    expect(await redo()).toBe("First");
    expect(await redo()).toBe("Manual");
    expect(await redo()).toBe("Second");
    // The record still shows the turn's actions in order and no step boundary of its own.
    expect((await receiptOf(runId)).actions).toEqual(receipt.actions);
  });
});

describe("the history association and the planning call", () => {
  it("undo, redo and a map's deletion write no history step under the group and carry no association", async () => {
    // Seeded defect: every successful map write received a history
    // association, though undo and redo move the cursor without recording
    // the group and a deletion removes the map's history.
    const { map, builder } = await seed();
    const other = createMap("Doomed map");
    const { stream, runId } = await turn([
      { text: "", toolCalls: [
        { id: "rename", name: "update_map", args: { id: map.id, name: "Renamed" } },
        { id: "undo", name: "undo_change", args: { id: map.id } },
        { id: "redo", name: "redo_change", args: { id: map.id } },
        { id: "delete", name: "delete_map", args: { id: other.id } },
      ] },
      { text: "Done", toolCalls: [] },
    ], builder, "Rename, undo, redo, delete");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required");
    expect(pending?.tool).toBe("delete_map");
    const resumed = await events(await api("/api/assistant/messages", { resolution: { pending: pending!.id, approved: true } }));
    const [rename, undo, redo] = results(stream);
    const [deleted] = results(resumed);
    expect([rename.ok, undo.ok, redo.ok, deleted.ok]).toEqual([true, true, true, true]);
    const group = rename.history?.group;
    expect(rename.history).toEqual({ mapId: map.id, group });
    expect(undo.history).toBeUndefined();
    expect(redo.history).toBeUndefined();
    expect(deleted.history).toBeUndefined();
    expect(storedSteps(group!)).toEqual([{ mapId: map.id, groupId: group, scope: "map", op: "update" }]);
    const receipt = await receiptOf(runId);
    expect((receipt.actions as { history?: unknown }[]).map((x) => x.history)).toEqual([rename.history, undefined, undefined, undefined]);
  });
  it("a planning call is recorded as planned, not as executed work", async () => {
    // Seeded defect: run_recipe with plan: true starts nothing but was
    // recorded "Ran the workflow …" with a done mark.
    const { builder } = await seed();
    const recipe = createRecipe("Planned workflow");
    addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "planned_output" } });
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "plan", name: "run_recipe", args: { id: recipe.id, plan: true } }] },
      { text: "Planned", toolCalls: [] },
    ], builder, "Plan the workflow");
    const [planned] = results(stream);
    expect(planned.ok).toBe(true);
    expect(planned.effects).toEqual({ readOnly: true, writes: [] });
    // The plan response carries no name, so the subject reads by its identity, as the label rule
    // documents.
    expect(planned.label).toBe(`Planned the workflow ${recipe.id}`);
    expect(planned.subject).toEqual({ resource: "recipes", id: recipe.id });
    expect(stream.some((e) => e.type === "confirm_required")).toBe(false);
    const receipt = await receiptOf(runId);
    expect((receipt.actions as { label?: string }[])[0].label).toBe(`Planned the workflow ${recipe.id}`);
  });
});

describe("a settled gate whose continuation stopped before its call", () => {
  it("keeps the decision in the receipt with the call's identity, and recovery shows the gate as confirmed but not done", async () => {
    // Seeded defect: the resolution retained the approved decision, the
    // continuation returned through its early-abort branch without an
    // action, and the pane's filter dropped every settled gate that has no
    // matching action, so recovery showed nothing for the resolved gate.
    const { map, builder } = await seed();
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "publish-gated", name: "publish_map", args: { id: map.id } }] },
      { text: "Never reached", toolCalls: [] },
    ], builder, "Publish the map");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required")!;
    const parked = pendingActions.claim(pending.id, "approved")!;
    assistantRuns.resume(runId, "approved");
    const controller = new AbortController(); controller.abort(new DOMException("departed", "AbortError"));
    const out: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, { baseUrl: origin, runId, pending: pendingActions, signal: controller.signal })) { assistantRuns.record(runId, event); out.push(event); }
    assistantRuns.finish(runId);
    expect(out).toEqual([{ type: "done", reason: "interrupted" }]);
    const receipt = await receiptOf(runId) as unknown as RunReceipt;
    expect(receipt.state).toBe("interrupted");
    expect(receipt.actions.some((a) => a.id === "publish-gated")).toBe(false);
    expect(receipt.confirmations).toEqual([expect.objectContaining({ id: pending.id, tool: "publish_map", decision: "approved", callId: "publish-gated" })]);
    // The map was not published: the gate was confirmed, the action never ran.
    expect(((await (await api(`/api/maps/${map.id}`)).json()) as { publishToken: string | null }).publishToken).toBeNull();
    const recovered = recoveredTurn(receipt);
    const entry = recovered.actions.find((a) => a.tool === "publish_map");
    expect(entry).toMatchObject({ status: "refused", decision: "approved", failure: { code: "approved_not_run" } });
    expect(entry!.label).toBe("Publish Original map (" + map.id + ")");
  });
});

// the shared registry's external group is not model-owned.
describe("assistant group ownership", () => {
  it("an attempted marker is absent from the retained action arguments", async () => {
    const { map, builder } = await seed();
    const malicious = "retained-model-marker";
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "retained-override", name: "update_map", args: { id: map.id, name: "Changed", change_group: malicious } }] },
      { text: "Done", toolCalls: [] },
    ], builder);
    expect(results(stream)[0].ok).toBe(true);
    expect(JSON.stringify(await receiptOf(runId))).not.toContain(malicious);
  });
  it("the model is offered no group input and an attempted override enters neither route nor receipt", async () => {
    const { map, builder } = await seed();
    const malicious = "model-owned-marker";
    const { provider, stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "override1", name: "update_map", args: { id: map.id, name: "First", change_group: malicious } }] },
      { text: "", toolCalls: [{ id: "override2", name: "update_map", args: { id: map.id, name: "Second", change_group: "second-marker" } }] },
      { text: "Done", toolCalls: [] },
    ], builder);
    for (const offered of provider.recording.exchanges.flatMap(exchange => exchange.offered)) {
      const offeredMap = offered.find(tool => tool.name === "update_map")!;
      expect(JSON.stringify(offeredMap.inputSchema)).not.toContain("change_group");
    }
    const changed = results(stream).filter(result => result.tool === "update_map");
    expect(changed).toHaveLength(2);
    expect(changed.every(result => result.ok)).toBe(true);
    const group = changed[0].history?.group;
    expect(group).toEqual(expect.any(String));
    expect(changed[1].history?.group).toBe(group);
    expect(dispatched.filter(entry => entry.method === "PATCH").map(entry => entry.request.headers.get("X-Change-Group"))).toEqual([group, group]);
    expect(JSON.stringify(await receiptOf(runId))).not.toContain(malicious);
    expect(storedSteps(group!)).toEqual([{ mapId: map.id, groupId: group, scope: "map", op: "update" }]);
  });
});
