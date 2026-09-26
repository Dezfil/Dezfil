import { afterEach, describe, it, expect, vi } from "vitest";
import type { WorkflowStep } from "../workflow-model";
import { EMPTY_HISTORY, type Definition, type History, type RecipeStep } from "./canvas-history";
import { wire, type WireCall } from "./fetch-wire";
import { makeRecording, type RecordingPorts } from "./history-recording";
import type { SaveState } from "./use-layout-saves";
import { RecipeEditor, type RetryPorts } from "./use-recipe-edits";

/**
 * The recording layer over the edit coordinator, and the window a moved
 * link's two edits stand open in: the panel's debounce is 400 ms and a
 * link's move is two PATCH round trips, so an edit from elsewhere
 * landing between the halves is the ordinary case, not a corner. The
 * coordinator under the layer is the **real** `RecipeEditor`, over a
 * fetch the test answers by hand, so each answer lands when the test
 * says and the interleaving is the test's, not the clock's. The retry
 * tests below measure the coordinator's continuations as well as the
 * layer's: with a seeded defect in the coordinator (its owned view
 * dropping the continuation) all three go red, which a stand-in that
 * hand-wrote the semantics could not show (the refuters' finding B; the
 * verification record names the run).
 */

const W = "w";
const OPEN_RETRY_STUB = { lockReason: () => null, say: () => undefined } satisfies RetryPorts;

const stepOf = (id: string, parameters: Record<string, unknown>, proposedParameters: Record<string, unknown> | null = null): WorkflowStep => ({
  id,
  ordinal: 0,
  operation: "filter_rows",
  parameters,
  proposedParameters,
  output: null,
  condition: "ready",
  conditions: ["ready"],
  causes: [],
  missingInputs: [],
  inputs: [],
  reads: [],
  latestAttempt: null,
  lastSuccessAt: null,
});

/** The server's answer to a call the coordinator made, as the API shapes
 * it: the step written, a proposal dropped, a node removed, a node added. */
function serve(call: WireCall) {
  const params = (call.body as { parameters?: Record<string, unknown> } | null)?.parameters ?? {};
  const id = call.path.match(/\/steps\/([^/]+)/)?.[1] ?? "fresh";
  if (call.method === "POST" && call.path.endsWith("/steps")) return call.ok({ step: stepOf("fresh", params) });
  if (call.method === "PATCH") return call.ok({ step: stepOf(id, params), applied: "active" });
  if (call.method === "DELETE" && call.path.endsWith("/proposal")) return call.ok({ step: stepOf(id, { name: id }) });
  if (call.method === "DELETE") return call.ok({ removed: id, output: { name: id, state: "never" }, readers: [], outputsRemain: false, message: "" });
  throw new Error(`nothing serves ${call.method} ${call.path}`);
}

/** The real coordinator over the wire, and what the frame's whisper was
 * handed: every failed state's Retry, in the order offered. */
function coordinator() {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  const whispered: (() => void)[] = [];
  const edits = new RecipeEditor(W, {
    onState: (s: SaveState) => {
      if (s.kind === "failed") whispered.push(s.retry);
    },
    onAccepted: () => undefined,
  }, OPEN_RETRY_STUB);
  /** The held edit for a node, answered with the definition it sent. */
  const answer = async (stepId: string) => {
    const call = w.pending("PATCH", `/api/recipes/${W}/steps/${stepId}`)[0];
    if (!call) throw new Error(`nothing on the wire for ${stepId}`);
    serve(call);
    await w.settle();
  };
  /** Everything on the wire fails: the browser never hears an answer. */
  const cutAll = async () => {
    for (const call of w.calls.filter((c) => !c.answered)) call.cut();
    await w.settle();
  };
  /** Everything on the wire is served. */
  const serveAll = async () => {
    for (const call of w.calls.filter((c) => !c.answered)) serve(call);
    await w.settle();
  };
  return { edits, w, whispered, answer, cutAll, serveAll };
}

function layerOver(before: Record<string, Definition>) {
  let history: History = EMPTY_HISTORY;
  const c = coordinator();
  // The newest definition the page knows for each node, kept as the hook
  // keeps it: an accepted answer is what the page knows from then on.
  const known = new Map(Object.entries(before));
  const ports: RecordingPorts = {
    edits: c.edits,
    record: () => history,
    put: (next) => {
      history = next;
    },
    known: (nodeId) => known.get(nodeId) ?? null,
    labelOf: (nodeId) => nodeId,
    operationLabel: (operation) => operation,
    editLabel: (nodeId) => `${nodeId} edited`,
    answered: (s) => known.set(s.id, { parameters: s.parameters, proposedParameters: s.proposedParameters }),
    forget: (id) => known.delete(id),
    watermarksFor: (ids) => Object.fromEntries(ids.map((id) => [id, null])),
    removalFacts: () => ({ operation: "filter_rows", ordinal: 0, position: null }),
    retry: OPEN_RETRY_STUB,
  };
  const recording = makeRecording();
  recording.setPorts(ports);
  return { ...c, layer: recording.edits, past: () => history.past as RecipeStep[] };
}

const def = (parameters: Record<string, unknown>): Definition => ({ parameters, proposedParameters: null });

afterEach(() => vi.unstubAllGlobals());

describe("a moved link is one step, and only of its own two edits", () => {
  const before = {
    holder: def({ input: "points", name: "holder" }),
    taker: def({ name: "taker" }),
    panel: def({ distance: 100, name: "panel" }),
  };

  it("an edit landing from elsewhere between the halves is its own step, and the move keeps its two", async () => {
    const { layer, answer, past, w } = layerOver(before);
    const moved = layer.composite(async (scoped) => {
      await scoped.edit("taker", { input: "points", name: "taker" });
      await scoped.edit("holder", { name: "holder" });
    });
    // The panel's debounce fires while the first half is on the wire:
    // its edit is on another node and belongs to nobody's composite.
    await w.settle();
    const typed = layer.edit("panel", { distance: 200, name: "panel" }, { field: "distance", session: "s1" });
    await answer("taker");
    await answer("panel");
    await answer("holder");
    await moved;
    await typed;

    const steps = past();
    expect(steps).toHaveLength(2);
    const relink = steps.find((s) => s.op.kind === "relink");
    const edit = steps.find((s) => s.op.kind === "edit");
    expect(relink && relink.op.kind === "relink" ? [relink.op.taker.nodeId, relink.op.holder.nodeId] : null).toEqual(["taker", "holder"]);
    expect(edit?.nodeId).toBe("panel");
    expect(edit && edit.op.kind === "edit" ? edit.op.session : null).toBe("s1");
  });

  it("a composite inside another keeps its own halves", async () => {
    const { layer, answer, past } = layerOver({ ...before, inner: def({ name: "inner" }), other: def({ input: "points", name: "other" }) });
    const outer = layer.composite(async (scoped) => {
      await scoped.edit("taker", { input: "points", name: "taker" });
      await scoped.composite(async (nested) => {
        await nested.edit("inner", { input: "points", name: "inner" });
        await nested.edit("other", { name: "other" });
      });
      await scoped.edit("holder", { name: "holder" });
    });
    await answer("taker");
    await answer("inner");
    await answer("other");
    await answer("holder");
    await outer;

    const relinks = past().filter((s) => s.op.kind === "relink");
    expect(relinks.map((s) => (s.op.kind === "relink" ? [s.op.taker.nodeId, s.op.holder.nodeId] : null))).toEqual([
      ["inner", "other"],
      ["taker", "holder"],
    ]);
  });
});

describe("a change that succeeds through Retry is a step", () => {
  // n2 carries a proposal, since a discard that drops nothing is no step.
  const before = { n1: def({ distance: 100, name: "n1" }), n2: { parameters: { name: "n2" }, proposedParameters: { name: "n2", distance: 50 } } };

  it("an edit retried from the whisper leaves the step its first attempt could not", async () => {
    const { layer, past, whispered, cutAll, serveAll, w } = layerOver(before);
    const first = layer.edit("n1", { distance: 200, name: "n1" }, { field: "distance", session: "s1" });
    await w.settle();
    await cutAll();
    expect((await first).kind).toBe("failed");
    expect(past()).toHaveLength(0);
    // The frame's Retry, pressed by the reader; the server answers this time.
    expect(whispered).toHaveLength(1);
    whispered[0]();
    await w.settle();
    await serveAll();
    const steps = past();
    expect(steps).toHaveLength(1);
    expect(steps[0].nodeId).toBe("n1");
    expect(steps[0].op.kind === "edit" ? steps[0].op.after.parameters : null).toEqual({ distance: 200, name: "n1" });
    expect(steps[0].op.kind === "edit" ? steps[0].op.before : null).toEqual(before.n1);
  });

  it("an add, a discard and a removal retried from the whisper each leave their step", async () => {
    const { layer, past, whispered, cutAll, serveAll, w } = layerOver(before);
    const added = layer.add({ operation: "buffer", parameters: { name: "fresh" } });
    const discarded = layer.discard("n2");
    const removed = layer.remove("n1");
    await w.settle();
    await cutAll();
    expect((await added).kind).toBe("failed");
    expect((await discarded).kind).toBe("failed");
    expect((await removed).kind).toBe("failed");
    expect(past()).toHaveLength(0);
    expect(whispered).toHaveLength(3);
    for (const retry of [...whispered]) {
      retry();
      await w.settle();
      await serveAll();
    }
    expect(past().map((s) => s.op.kind)).toEqual(["add", "discard", "remove"]);
  });

  it("a half retried after its move has closed stands as the edit it is", async () => {
    const { layer, past, whispered, cutAll, serveAll, w } = layerOver({ ...before, taker: def({ name: "taker" }), holder: def({ input: "points", name: "holder" }) });
    const moved = layer.composite(async (scoped) => {
      await scoped.edit("taker", { input: "points", name: "taker" });
      await scoped.edit("holder", { name: "holder" });
    });
    // Both halves fail their first attempt, one after the other, so the
    // move records nothing.
    await w.settle();
    await cutAll();
    await cutAll();
    await moved;
    expect(past()).toHaveLength(0);
    expect(whispered).toHaveLength(2);
    // The reader retries them one at a time, long after.
    for (const retry of [...whispered]) {
      retry();
      await w.settle();
      await serveAll();
    }
    expect(past().map((s) => [s.nodeId, s.op.kind])).toEqual([
      ["taker", "edit"],
      ["holder", "edit"],
    ]);
  });
});

describe("the definition before a change is what the node held once the change before it settled", () => {
  it("two edits of one node, the second made while the first is on the wire: the second's before is the first's after, not what stood before both", async () => {
    const { layer, answer, past, w } = layerOver({ n1: def({ distance: 100, name: "n1" }) });
    const first = layer.edit("n1", { distance: 200, name: "n1" });
    await w.settle();
    // The second waits in the node's lane while the first is on the wire.
    const second = layer.edit("n1", { distance: 300, name: "n1" });
    await w.settle();
    expect(w.pending("PATCH", `/api/recipes/${W}/steps/n1`)).toHaveLength(1);
    await answer("n1");
    await answer("n1");
    await first;
    await second;
    const steps = past();
    expect(steps).toHaveLength(2);
    // Undoing only the second must put back what the first made, not
    // what stood before both.
    expect(steps.map((s) => (s.op.kind === "edit" ? [s.op.before.parameters.distance, s.op.after.parameters.distance] : null))).toEqual([
      [100, 200],
      [200, 300],
    ]);
  });

  it("a discard made while an edit is on the wire drops the proposal that edit made, and its step says so", async () => {
    const { layer, past, w } = layerOver({ n2: { parameters: { name: "n2" }, proposedParameters: { name: "n2", distance: 50 } } });
    const edited = layer.edit("n2", { name: "n2", distance: 60 });
    await w.settle();
    // The discard waits for the node's lane; the edit lands as a proposal first.
    const discarded = layer.discard("n2");
    await w.settle();
    w.pending("PATCH", `/api/recipes/${W}/steps/n2`)[0].ok({ step: stepOf("n2", { name: "n2" }, { name: "n2", distance: 60 }), applied: "proposed" });
    await w.settle();
    w.pending("DELETE", `/api/recipes/${W}/steps/n2/proposal`)[0].ok({ step: stepOf("n2", { name: "n2" }) });
    await edited;
    await discarded;
    const discard = past().find((s) => s.op.kind === "discard");
    expect(discard && discard.op.kind === "discard" ? discard.op.before.proposedParameters : null).toEqual({ name: "n2", distance: 60 });
  });
});
