import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "../workflow-model";
import { EMPTY_HISTORY, type Definition, type Direction, type History, type RecipeStep } from "./canvas-history";
import { wire } from "./fetch-wire";
import type { ReadStep } from "./history-inverses";
import { readRecipe, runInverse, type OperationScreen } from "./history-operation";
import { makeRecording } from "./history-recording";
import type { SaveState } from "./use-layout-saves";
import { RecipeEditor } from "./use-recipe-edits";

/**
 * The continuation a failed change hands the frame's whisper, measured
 * on the real `RecipeEditor` over a fetch the test answers by hand,
 * with the real recording layer over it and the real history operation
 * beside it. The refuters' probe: a recipe inverse issues its request
 * only after its read has answered, and an ordinary change made from
 * the canvas inside that window must keep its own Retry and lend the
 * inverse nothing, so that the inverse's failure offers the inverse's
 * own resume, which meets the lock before it sends anything. Seen red
 * against the coordinator that read one shared owner slot when a call
 * was made (the verification record names the run).
 */

const LOCK = "Canvas locked. Unlock to edit.";
const W = "w1";

const stepOf = (id: string, parameters: Record<string, unknown>, ordinal = 0): WorkflowStep => ({
  id,
  ordinal,
  operation: "buffer",
  parameters,
  proposedParameters: null,
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
const reading = (id: string, parameters: Record<string, unknown>, ordinal = 0): ReadStep => ({ id, operation: "buffer", ordinal, parameters, proposedParameters: null, output: null, lastSuccessAt: null });

/** The canvas's pieces as the page composes them, over the wire: the
 * coordinator the screen makes, the recording layer the pane and the
 * panel call, and the operation an undo runs. */
function canvas() {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  const whispers: SaveState[] = [];
  const said: string[] = [];
  const screen: OperationScreen = {
    lockReason: null,
    say: (text) => said.push(text),
    failed: (message, retry) => whispers.push({ kind: "failed", message, retry }),
    recovered: () => whispers.push({ kind: "saved" }),
    runWord: () => null,
    stored: () => ({}),
    dropNode: () => undefined,
    placeNode: () => undefined,
  };
  const retryPorts = { lockReason: () => screen.lockReason, say: screen.say };
  const editor = new RecipeEditor(W, { onState: (s) => whispers.push(s), onAccepted: () => undefined }, retryPorts);
  let history: History = EMPTY_HISTORY;
  const known = new Map<string, Definition>([["n1", { parameters: { input: "points", distance: 100, name: "n1" }, proposedParameters: null }]]);
  const recording = makeRecording();
  recording.setPorts({
    edits: editor,
    record: () => history,
    put: (next) => {
      history = next;
    },
    known: (id) => known.get(id) ?? null,
    labelOf: (id) => id,
    operationLabel: (op) => op,
    editLabel: (id) => `${id} edited`,
    answered: (s) => known.set(s.id, { parameters: s.parameters, proposedParameters: s.proposedParameters }),
    forget: (id) => known.delete(id),
    watermarksFor: (ids) => Object.fromEntries(ids.map((id) => [id, null])),
    removalFacts: () => ({ operation: "buffer", ordinal: 0, position: null }),
    retry: retryPorts,
  });
  let queue = Promise.resolve();
  const press = (direction: Direction, step: RecipeStep) =>
    runInverse(step, direction, {
      edits: editor,
      screen: () => screen,
      read: () => readRecipe(W),
      record: () => history,
      put: (next) => {
        history = next;
      },
      labelOf: (id) => id,
      answered: () => undefined,
      forget: () => undefined,
      enqueue: (job) => {
        queue = queue.then(job).catch(() => undefined);
      },
    });
  /** The Retry the whisper offers now: the newest failure's. */
  const retryOffered = () => {
    const failed = [...whispers].reverse().find((s) => s.kind === "failed");
    return failed && failed.kind === "failed" ? failed.retry : null;
  };
  return { w, editor, recording, screen, said, whispers, history: () => history, press, retryOffered };
}

describe("a change's Retry travels with the call (behaviours 5 and 7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an inverse's failure offers the inverse's own resume, not the Retry of an add made while its read was on the wire; the resume meets the lock", async () => {
    const c = canvas();
    // n1 edited from the panel and accepted: one step in the record.
    const edited = c.recording.edits.edit("n1", { input: "points", distance: 200, name: "n1" }, { field: "distance", session: "s1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 200, name: "n1" }), applied: "active" });
    await edited;
    expect(c.history().past).toHaveLength(1);
    const step = c.history().past[0] as RecipeStep;
    // Undo pressed: the inverse reads the workflow first.
    const undo = c.press("undo", step);
    await c.w.settle();
    expect(c.w.pending("GET", `/api/recipes/${W}`)).toHaveLength(1);
    // An ordinary add from the canvas while that read is on the wire.
    const added = c.recording.edits.add({ operation: "buffer", parameters: { input: "points", distance: 50, name: "fresh" } });
    await c.w.settle();
    expect(c.w.pending("POST", `/api/recipes/${W}/steps`)).toHaveLength(1);
    // The inverse waits for the accepted add on the same document.
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" })] } });
    await c.w.settle();
    expect(c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)).toHaveLength(0);
    c.w.pending("POST", `/api/recipes/${W}/steps`)[0].ok({ step: stepOf("fresh", { input: "points", distance: 50, name: "fresh" }, 1) });
    await added; await c.w.settle();
    const inversePatch = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`);
    expect(inversePatch).toHaveLength(1);
    expect(inversePatch[0].body).toEqual({ parameters: { input: "points", distance: 100, name: "n1" } });
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "buffer added"]);
    // The inverse's PATCH fails: the whisper offers Retry.
    inversePatch[0].cut();
    await undo;
    const retry = c.retryOffered();
    expect(retry).not.toBeNull();
    expect(c.said.at(-1)).toMatch(/^Not undone: Couldn't save the change/);
    // The canvas is locked before Retry is pressed.
    c.screen.lockReason = LOCK;
    const posts = c.w.calls.filter((x) => x.method === "POST").length;
    retry!();
    await c.w.settle();
    // The inverse's own resume ran: it met the lock, said so, and sent
    // nothing. No second add went out, and nothing is on the wire.
    expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(posts);
    expect(c.said.at(-1)).toBe(LOCK);
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
    // The step is kept where it was: the same Retry resumes it once unlocked.
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "buffer added"]);
    c.screen.lockReason = null;
    retry!();
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" }), reading("fresh", { input: "points", distance: 50, name: "fresh" }, 1)] } });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 100, name: "n1" }), applied: "active" });
    await c.w.settle();
    expect(c.said.at(-1)).toBe("Undone: n1 edited");
    expect(c.history().past.map((s) => s.label)).toEqual(["buffer added"]);
    expect(c.history().future.map((s) => s.label)).toEqual(["n1 edited"]);
  });

  it("an ordinary change's failure offers its own Retry while an inverse's read is on the wire, and the retried change is a step", async () => {
    const c = canvas();
    const edited = c.recording.edits.edit("n1", { input: "points", distance: 200, name: "n1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 200, name: "n1" }), applied: "active" });
    await edited;
    const step = c.history().past[0] as RecipeStep;
    const undo = c.press("undo", step);
    await c.w.settle();
    // The add's POST fails while the inverse's read is still on the wire.
    const added = c.recording.edits.add({ operation: "buffer", parameters: { input: "points", distance: 50, name: "fresh" } });
    await c.w.settle();
    c.w.pending("POST", `/api/recipes/${W}/steps`)[0].cut();
    expect((await added).kind).toBe("failed");
    const retry = c.retryOffered();
    expect(retry).not.toBeNull();
    // Its Retry re-issues the add and nothing of the inverse: the read is
    // still the one call on the wire beside it.
    retry!();
    await c.w.settle();
    expect(c.w.pending("POST", `/api/recipes/${W}/steps`)).toHaveLength(1);
    expect(c.w.pending("GET", `/api/recipes/${W}`)).toHaveLength(1);
    c.w.pending("POST", `/api/recipes/${W}/steps`)[0].ok({ step: stepOf("fresh", { input: "points", distance: 50, name: "fresh" }, 1) });
    await c.w.settle();
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "buffer added"]);
    // The inverse, still its own: its read answers and its PATCH lands.
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" }), reading("fresh", { input: "points", distance: 50, name: "fresh" }, 1)] } });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 100, name: "n1" }), applied: "active" });
    await undo;
    expect(c.said.at(-1)).toBe("Undone: n1 edited");
    expect(c.history().future.map((s) => s.label)).toEqual(["n1 edited"]);
  });
});

describe("ordinary recipe Retry meets the canvas lock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an owned recording edit recoverable but sends no Retry while locked", async () => {
    const c = canvas();
    const first = c.recording.edits.edit("n1", { input: "points", distance: 240, name: "n1" }, { field: "distance", session: "s1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].cut();
    expect((await first).kind).toBe("failed");
    const failed = c.whispers.at(-1);
    expect(failed?.kind).toBe("failed");
    if (!failed || failed.kind !== "failed") throw new Error("the owned edit offered no Retry");

    c.screen.lockReason = LOCK;
    failed.retry();
    await c.w.settle();
    const escaped = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`).map((call) => ({ method: call.method, path: call.path, body: call.body }));
    expect({ count: escaped.length, escaped }).toEqual({ count: 0, escaped: [] });
    expect(c.said.at(-1)).toBe(LOCK);
    expect(c.whispers.at(-1)).toBe(failed);
    expect(c.history().past).toHaveLength(0);

    c.screen.lockReason = null;
    failed.retry();
    await c.w.settle();
    const retry = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0];
    expect(retry.body).toEqual({ parameters: { input: "points", distance: 240, name: "n1" } });
    retry.ok({ step: stepOf("n1", { input: "points", distance: 240, name: "n1" }), applied: "active" });
    await c.w.settle();
    expect(c.history().past).toHaveLength(1);
    expect(c.history().past[0].label).toBe("n1 edited");
  });

  it("keeps an un-owned coordinator edit recoverable but sends no fallback Retry while locked", async () => {
    const c = canvas();
    const first = c.editor.edit("n1", { input: "points", distance: 360, name: "n1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].cut();
    expect((await first).kind).toBe("failed");
    const failed = c.whispers.at(-1);
    expect(failed?.kind).toBe("failed");
    if (!failed || failed.kind !== "failed") throw new Error("the raw edit offered no Retry");

    c.screen.lockReason = LOCK;
    failed.retry();
    await c.w.settle();
    const escaped = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`).map((call) => ({ method: call.method, path: call.path, body: call.body }));
    expect({ count: escaped.length, escaped }).toEqual({ count: 0, escaped: [] });
    expect(c.said.at(-1)).toBe(LOCK);
    expect(c.whispers.at(-1)).toBe(failed);

    c.screen.lockReason = null;
    failed.retry();
    await c.w.settle();
    const retry = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0];
    expect(retry.body).toEqual({ parameters: { input: "points", distance: 360, name: "n1" } });
    retry.ok({ step: stepOf("n1", { input: "points", distance: 360, name: "n1" }), applied: "active" });
    await c.w.settle();
  });

  it("lets work queued before locking follow its ordinary lane outcome", async () => {
    const c = canvas();
    const first = c.recording.edits.edit("n1", { input: "points", distance: 180, name: "n1" }, { field: "distance", session: "s1" });
    const queued = c.recording.edits.edit("n1", { input: "points", distance: 220, name: "n1" }, { field: "distance", session: "s2" });
    await c.w.settle();
    const onWire = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`);
    expect(onWire).toHaveLength(1);
    expect(onWire[0].body).toEqual({ parameters: { input: "points", distance: 180, name: "n1" } });

    c.screen.lockReason = LOCK;
    onWire[0].ok({ step: stepOf("n1", { input: "points", distance: 180, name: "n1" }), applied: "active" });
    await c.w.settle();
    const sentFromQueue = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`);
    expect(sentFromQueue).toHaveLength(1);
    expect(sentFromQueue[0].body).toEqual({ parameters: { input: "points", distance: 220, name: "n1" } });
    sentFromQueue[0].ok({ step: stepOf("n1", { input: "points", distance: 220, name: "n1" }), applied: "active" });
    expect((await first).kind).toBe("accepted");
    expect((await queued).kind).toBe("accepted");
    await c.w.settle();
    expect(c.said).toEqual([]);
    expect(c.history().past).toHaveLength(2);
  });
});
