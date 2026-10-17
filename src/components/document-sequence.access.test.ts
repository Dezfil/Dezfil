import { afterEach, describe, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "./workflow-canvas/hook-harness";
import { wire } from "./workflow-canvas/fetch-wire";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { WorkflowListing } from "./workflow-model";
vi.mock("react", () => hookReact);
import { DocumentSequence } from "./document-sequence";
import { useBuilderMutations } from "./builder/use-builder-mutations";
import { WorkflowDocument } from "./workflow-canvas/workflow-document";
import { LayoutSaveCoordinator, type SaveState } from "./workflow-canvas/layout-save-coordinator";
import { RecipeEditor } from "./workflow-canvas/use-recipe-edits";
import { useWorkflowRun, type WorkflowRunner } from "./workflow-canvas/use-workflow-run";
import { useRunConfirm } from "./workflow-canvas/use-run-confirm";
import { useWorkflowEditorPort } from "./workflow-canvas/use-workflow-editor-port";
import type { Wire } from "./workflow-canvas/fetch-wire";

/**
 * An editor left open after its person loses access: removed from the
 * project (the document answers as absent), made a Viewer, or its owner
 * deactivated (the change is refused as not theirs). Every later save
 * would meet the same refusal, so the write sequence halts on it as it
 * does on a stale revision: what is queued is not sent, and the editor
 * shows its halted state rather than failing save after save.
 */

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

const REFUSALS = [
  ["no longer reached", 404, "not_found", "The requested resource was not found."],
  ["no longer theirs to change", 403, "forbidden", "You can view this but cannot make this change."],
] as const;

/** The publication settings that travel through ordinary edits. Changing
 * one is the map owner's alone, so an Editor's change is refused while
 * their editing stands: the refusal says nothing about their access. */
const PUBLICATION = [
  ["the map's widget publication toggle", "/api/maps/m", { widgetsPublished: true }],
  ["a layer's published fields", "/api/layers/l", { publishedFields: ["label"] }],
] as const;
const OWNERS_ALONE = [403, "forbidden", "You can view this but cannot make this change."] as const;

describe("the write sequence", () => {
  it.each(REFUSALS)("halts on a write refused as %s", async (_name, status, code, message) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const sequence = new DocumentSequence("m");
    sequence.accept({ editRevision: "seen" });
    const answer = sequence.writeFetch("/api/maps/m", { method: "PATCH", body: "{}" });
    w.pending("PATCH", "/api/maps/m")[0].refuse(status, code, message);
    expect((await answer).status).toBe(status);
    expect(sequence.stale).toBe(true);
    // Nothing more goes out.
    expect((await sequence.writeFetch("/api/maps/m", { method: "PATCH", body: "{}" })).status).toBe(409);
    expect(w.calls).toHaveLength(1);
  });

  it("does not halt on a read that finds nothing, or on a refused change to the publication, which is the owner's alone", async () => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const sequence = new DocumentSequence("m");
    sequence.accept({ editRevision: "seen" });
    const read = sequence.writeFetch("/api/layers/gone");
    w.pending("GET", "/api/layers/gone")[0].refuse(404, "not_found", "The requested resource was not found.");
    await read;
    const publish = sequence.writeFetch("/api/maps/m/publish", { method: "POST", body: "{}" });
    w.pending("POST", "/api/maps/m/publish")[0].refuse(403, "forbidden", "You can view this but cannot make this change.");
    await publish;
    // Another refusal of a write leaves it running too.
    const invalid = sequence.writeFetch("/api/maps/m", { method: "PATCH", body: "{}" });
    w.pending("PATCH", "/api/maps/m")[0].refuse(400, "invalid_request", "Bad.");
    await invalid;
    expect(sequence.stale).toBe(false);
  });

  it.each(PUBLICATION)("does not halt when an Editor's change to %s is refused as the owner's, and sends the next edit", async (_name, path, body) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const sequence = new DocumentSequence("m");
    sequence.accept({ editRevision: "seen" });
    const refused = sequence.writeFetch(path, { method: "PATCH", body: JSON.stringify(body) });
    w.pending("PATCH", path)[0].refuse(...OWNERS_ALONE);
    expect((await refused).status).toBe(403);
    expect(sequence.stale).toBe(false);
    expect(sequence.accessLost).toBe(false);
    const next = sequence.writeFetch("/api/maps/m", { method: "PATCH", body: JSON.stringify({ name: "Next" }) });
    w.pending("PATCH", "/api/maps/m")[0].ok({ editRevision: "next" });
    expect((await next).ok).toBe(true);
    expect(w.calls.map(call => call.body)).toEqual([body, { name: "Next" }]);
  });
});

describe("the builder", () => {
  it.each(REFUSALS)("stops saving the map once a save is refused as %s, and sends nothing queued", async (_name, status, code, message) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const initial = { id: "m", name: "Map", basemap: "light", basemapLayers: null, layers: [], widgets: [], editRevision: "seen" } as unknown as MapWithLayers;
    let map = initial;
    const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = (typeof next === "function" ? next(map) : next)!; }, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} }));
    cleanups.push(() => h.unmount());
    h.value.serverMapRef.current = initial; h.value.sequence.accept(initial);
    const saved = h.value.patchMap({ basemap: "dark" });
    const next = h.value.patchMap({ name: "Queued name" });
    w.pending("PATCH", "/api/maps/m")[0].refuse(status, code, message);
    await w.settle(); await w.settle();
    const writes = w.calls.filter(call => call.method !== "GET").length;
    // Whatever else went out is answered, so a regression reads as a count, not a hang.
    for (const call of w.calls.filter(call => !call.answered)) call.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
    await Promise.allSettled([saved, next]);
    expect(writes).toBe(1);
    expect(h.render().stale).toBe(true);
  });

  it.each(PUBLICATION)("keeps saving after an Editor's change to %s is refused as the owner's: the refusal is shown and the next change goes out", async (_name, path, body) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const initial = { id: "m", name: "Map", basemap: "light", basemapLayers: null, layers: [], widgets: [], widgetsPublished: false, editRevision: "seen" } as unknown as MapWithLayers;
    let map = initial;
    const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = (typeof next === "function" ? next(map) : next)!; }, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} }));
    cleanups.push(() => h.unmount());
    h.value.serverMapRef.current = initial; h.value.sequence.accept(initial);
    // The toggle saves through the map's lane; the published fields through
    // the editor's request, as the publish popover sends them.
    const refused = path === "/api/maps/m"
      ? h.value.patchMap(body)
      : h.value.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    w.pending("PATCH", path)[0].refuse(...OWNERS_ALONE);
    await refused;
    expect(h.render().stale).toBe(false);
    if (path === "/api/maps/m") expect(h.render().failures.map).toBe(OWNERS_ALONE[2]);
    else expect((await refused as Response).status).toBe(403);
    const renamed = h.value.patchMap({ name: "Next" });
    await w.settle();
    const next = w.pending("PATCH", "/api/maps/m");
    expect(next.map(call => call.body)).toEqual([{ name: "Next" }]);
    next[0].ok({ ...initial, name: "Next", editRevision: "next" });
    expect(await renamed).toBe(true);
    expect(h.render().stale).toBe(false);
  });
});

describe("the workflow canvas", () => {
  it.each(REFUSALS)("stops saving the workflow once an edit is refused as %s: the queued layout is not sent and the canvas reads halted", async (_name, status, code, message) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const doc = new WorkflowDocument("w");
    const layout = { steps: { n: { x: 0, y: 0 } }, sources: {}, notes: [], updatedAt: null, editRevision: "seen" };
    const recipe = { id: "w", steps: [{ id: "n", parameters: { distance: 10 } }], editRevision: "seen" } as unknown as WorkflowListing;
    doc.install(recipe, layout);
    const states: SaveState[] = [];
    const ports = { onState: (state: SaveState) => states.push(state), lockReason: () => null, say() {}, onAccepted() {} };
    const saves = new LayoutSaveCoordinator("w", layout, { ...ports, graph: { members: [], edges: [], presentSourceCount: 0 } }, doc);
    const edits = new RecipeEditor("w", ports, ports, doc);
    const edited = edits.edit("n", { distance: 20 });
    saves.save({ positions: { n: { x: 100, y: 50 } }, notes: [] });
    w.calls[0].refuse(status, code, message);
    await w.settle(); await w.settle();
    const sent = w.calls.length;
    for (const call of w.calls.filter(call => !call.answered)) call.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
    await edited; await doc.idle();
    expect(sent).toBe(1);
    expect(doc.stale).toBe(true);
    expect(states.at(-1)).toMatchObject({ kind: "stale" });
    // The person's typed value is kept for copying before a reload.
    expect(edits.drafts.get("n")?.displayValues).toEqual({ distance: 20 });
  });
});

const SAYS_ENDED = "You can no longer edit this item. Reload the page to continue.";
const SAYS_STALE = "This item has changed. Reload it before trying again.";
/** Each way a write sequence halts, and the words every later refusal says. */
const HALTS = [
  ...REFUSALS.map(([name, status, code, message]) => [`access ended (${name})`, status, code, message, SAYS_ENDED] as const),
  ["a stale revision", 409, "stale_revision", SAYS_STALE, SAYS_STALE] as const,
];

/** A write the server refuses as given, halting the sequence. */
async function halt(sequence: DocumentSequence, w: Wire, path: string, status: number, code: string, message: string) {
  sequence.accept({ editRevision: "seen" });
  const answer = sequence.writeFetch(path, { method: "PATCH", body: "{}" });
  w.pending("PATCH", path)[0].refuse(status, code, message);
  await answer;
  expect(sequence.stale).toBe(true);
}

describe("what a halted editor says", () => {
  it.each(HALTS)("refuses a later write in its own words after %s, sending nothing", async (_name, status, code, message, says) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const sequence = new DocumentSequence("m");
    await halt(sequence, w, "/api/maps/m", status, code, message);
    const later = await sequence.writeFetch("/api/maps/m", { method: "PATCH", body: "{}" });
    expect(later.status).toBe(409);
    expect((await later.json()).error.message).toBe(says);
    expect(w.calls).toHaveLength(1);
  });

  it.each(HALTS)("refuses a Run in its own words after %s, starting nothing", async (_name, status, code, message, says) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const doc = new WorkflowDocument("w");
    await halt(doc, w, "/api/recipes/w/steps/n", status, code, message);
    const h = new HookHarness(() => useWorkflowRun("w", { settle: async () => null, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }, doc, true));
    const flow = new HookHarness(() => useRunConfirm({ runner: h.value }));
    cleanups.push(() => { flow.unmount(); h.unmount(); });
    // Run asks for the plan first; the refusal is said at the action.
    await flow.value.askRun(null); flow.render();
    expect(flow.value.refusal?.message).toBe(says);
    expect(await h.value.plan()).toEqual({ refused: `Couldn't save the change, so nothing started. ${says}` });
    expect(await h.value.start({ members: ["n"] })).toEqual({ kind: "save_failed", message: says });
    expect(await h.value.runNode("n")).toEqual({ kind: "save_failed", message: says });
    expect(w.calls).toHaveLength(1);
  });

  it.each(HALTS)("settles the workflow's edits in its own words after %s", async (_name, status, code, message, says) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const doc = new WorkflowDocument("w");
    await halt(doc, w, "/api/recipes/w/steps/n", status, code, message);
    const ports = { onState() {}, lockReason: () => null, say() {}, onAccepted() {} };
    const edits = new RecipeEditor("w", ports, ports, doc);
    expect(await edits.settled()).toMatchObject({ kind: "refused", message: says });
  });

  it.each(HALTS)("refuses the assistant's turn on a workflow in its own words after %s", async (_name, status, code, message, says) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    const doc = new WorkflowDocument("w");
    await halt(doc, w, "/api/recipes/w/steps/n", status, code, message);
    const runner = { observe: async () => {} } as unknown as WorkflowRunner;
    const h = new HookHarness(() => useWorkflowEditorPort("w", doc, runner, async () => true, () => {}));
    cleanups.push(() => h.unmount());
    const work = vi.fn(async () => {});
    await expect(h.value.turn(work)).rejects.toMatchObject({ message: says });
    expect(work).not.toHaveBeenCalled();
  });

  it.each(HALTS)("refuses the assistant's turn on a map in its own words after %s", async (_name, status, code, message, says) => {
    const w = wire(); vi.stubGlobal("fetch", w.fetch);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const initial = { id: "m", name: "Map", basemap: "light", basemapLayers: null, layers: [], widgets: [], editRevision: "seen" } as unknown as MapWithLayers;
    let map = initial;
    const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = (typeof next === "function" ? next(map) : next)!; }, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} }));
    cleanups.push(() => h.unmount());
    await halt(h.value.sequence, w, "/api/maps/m", status, code, message);
    const work = vi.fn(async () => {});
    await expect(h.value.turn(work)).rejects.toMatchObject({ message: says });
    expect(work).not.toHaveBeenCalled();
  });
});
