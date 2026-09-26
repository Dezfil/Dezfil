import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "../workflow-model";
import { EMPTY_HISTORY, reasons, type Definition, type Direction, type History, type RecipeStep } from "./canvas-history";
import { wire } from "./fetch-wire";
import type { ReadStep } from "./history-inverses";
import { readRecipe, runInverse, type OperationScreen } from "./history-operation";
import { makeRecording } from "./history-recording";
import type { SaveState } from "./use-layout-saves";
import { RecipeEditor, type RetryPorts } from "./use-recipe-edits";

/**
 * The history operation's refusals, on the real coordinator over a fetch
 * the test answers by hand: a step the record no longer holds when the
 * read answers is refused for the reason that took it. A run that wrote
 * the node's dataset is one cause; a fresh step made while the inverse
 * was on the wire, which forgets the undone side, is another, and
 * nothing ran. Seen red against the operation that said *has run since*
 * for both (the refuters' finding D; the verification record names the
 * run).
 */

const W = "w2";
const OPEN_RETRY_STUB = { lockReason: () => null, say: () => undefined } satisfies RetryPorts;

const stepOf = (id: string, parameters: Record<string, unknown>, ordinal = 0, lastSuccessAt: string | null = null): WorkflowStep => ({
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
  lastSuccessAt,
});
const reading = (id: string, parameters: Record<string, unknown>, ordinal = 0, lastSuccessAt: string | null = null): ReadStep => ({
  id,
  operation: "buffer",
  ordinal,
  parameters,
  proposedParameters: null,
  output: null,
  lastSuccessAt,
});

function canvas() {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  /** The frame's whisper, as the coordinator and the operation set it. */
  const whispers: SaveState[] = [];
  const editor = new RecipeEditor(W, { onState: (s) => whispers.push(s), onAccepted: () => undefined }, OPEN_RETRY_STUB);
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
    retry: OPEN_RETRY_STUB,
  });
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
      enqueue: (job) => void job(),
    });
  /** N1 edited and accepted, then undone: one step on the redo side. */
  const undone = async () => {
    const edited = recording.edits.edit("n1", { input: "points", distance: 200, name: "n1" });
    await w.settle();
    w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 200, name: "n1" }), applied: "active" });
    await edited;
    const step = history.past[0] as RecipeStep;
    const undo = press("undo", step);
    await w.settle();
    w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" })] } });
    await w.settle();
    w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 100, name: "n1" }), applied: "active" });
    await undo;
    expect(history.future).toEqual([step]);
    return step;
  };
  const seed = (h: History) => {
    history = h;
  };
  /** The Retry the whisper offers now: the newest failure's. */
  const retryOffered = () => {
    const failed = [...whispers].reverse().find((x) => x.kind === "failed");
    return failed && failed.kind === "failed" ? failed.retry : null;
  };
  return { w, recording, said, screen, whispers, history: () => history, press, undone, seed, retryOffered };
}

describe("a step the record no longer holds when the read answers is refused for the reason that took it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forgotten by a fresh step made while the redo's read was on the wire: says so, and not that anything ran", async () => {
    const c = canvas();
    const step = await c.undone();
    // Redo pressed: the read goes out.
    const redo = c.press("redo", step);
    await c.w.settle();
    // A fresh edit from the panel lands meanwhile and forgets the undone side.
    const fresh = c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 300, name: "n1" }), applied: "active" });
    await fresh;
    expect(c.history().future).toEqual([]);
    // The read answers, with nothing run: the redo is refused for the
    // fresh step, in its own words.
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 300, name: "n1" })] } });
    await redo;
    expect(c.said.at(-1)).toBe("Not redone: n1 edited was forgotten by a newer step");
    expect(c.said.at(-1)).not.toContain("has run since");
    // Nothing was sent for it, and the fresh step stands.
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited"]);
  });

  it("settled away by a run that wrote the node's dataset: says the node has run since", async () => {
    const c = canvas();
    const step = await c.undone();
    const redo = c.press("redo", step);
    await c.w.settle();
    // The read shows n1's last success advanced past the step's watermark.
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 100, name: "n1" }, 0, "2026-08-29T10:00:00Z")] } });
    await redo;
    expect(c.said.at(-1)).toBe(`Not redone: ${reasons.ranSince("n1")}`);
    expect(c.history().future).toEqual([]);
  });
});

/**
 * The lock, met again before every write: an inverse reads the workflow
 * first and the canvas stays live meanwhile, so a lock turned on during
 * the read, or between the stages of a restoration, must be met before
 * the next request goes out, the step left where it is and the reason
 * said. Seen red against the operation that read the lock once, before
 * its read (found at review).
 */
const LOCK = "Canvas locked. Unlock to edit.";

describe("the lock is met again before every write", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("locked while the inverse's read is on the wire: nothing is sent, the reason is said, the step kept", async () => {
    const c = canvas();
    const edited = c.recording.edits.edit("n1", { input: "points", distance: 200, name: "n1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 200, name: "n1" }), applied: "active" });
    await edited;
    const step = c.history().past[0] as RecipeStep;
    const undo = c.press("undo", step);
    await c.w.settle();
    // The canvas is locked while the read is on the wire; then the read answers.
    c.screen.lockReason = LOCK;
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" })] } });
    await c.w.settle();
    expect(c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)).toEqual([]);
    await undo;
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
    expect(c.said.at(-1)).toContain(LOCK);
    expect(c.history().past).toEqual([step]);
    expect(c.history().future).toEqual([]);
  });

  it("locked between a restoration's add and its order: the order waits, the step is kept, and the next press once unlocked adopts the node rather than adding a second", async () => {
    const c = canvas();
    const step: RecipeStep = {
      kind: "recipe",
      nodeId: "old",
      watermarks: { old: null },
      op: { kind: "remove", operation: "buffer", parameters: { input: "points", distance: 100, name: "old" }, position: { x: 48, y: 40 }, ordinal: 0, dataset: "never" },
      label: "old removed",
    };
    c.seed({ ...EMPTY_HISTORY, past: [step] });
    const undo = c.press("undo", step);
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("other", { input: "points", distance: 5, name: "other" })] } });
    await c.w.settle();
    const post = c.w.pending("POST", `/api/recipes/${W}/steps`);
    expect(post).toHaveLength(1);
    // Locked while the add is on the wire; the add lands.
    c.screen.lockReason = LOCK;
    post[0].ok({ step: stepOf("fresh", { input: "points", distance: 100, name: "old" }, 1) });
    await c.w.settle();
    // No order went out, nothing else either; the step is kept for the next press.
    expect(c.w.pending("POST", `/api/recipes/${W}/steps/fresh/move`)).toEqual([]);
    await undo;
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
    expect(c.said.at(-1)).toContain(LOCK);
    expect(c.history().past).toEqual([step]);
    // Unlocked, the next press reads again and finishes only what is missing.
    c.screen.lockReason = null;
    const again = c.press("undo", step);
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({
      recipe: { steps: [reading("other", { input: "points", distance: 5, name: "other" }), reading("fresh", { input: "points", distance: 100, name: "old" }, 1)] },
    });
    await c.w.settle();
    expect(c.w.pending("POST", `/api/recipes/${W}/steps`)).toEqual([]);
    const move = c.w.pending("POST", `/api/recipes/${W}/steps/fresh/move`);
    expect(move).toHaveLength(1);
    move[0].ok({});
    await again;
    expect(c.said.at(-1)).toBe("Undone: old removed");
    expect(c.history().past).toEqual([]);
    expect(c.history().future.map((s) => (s.kind === "recipe" ? s.nodeId : null))).toEqual(["fresh"]);
  });
});

/**
 * The whisper an inverse's failure raised is cleared once the inverse is
 * over: a Retry whose fresh read finds the stage already landed (the
 * request went through, its answer lost) sends nothing, so no
 * coordinator callback ever says "saved", and the frame kept "Couldn't
 * save · Retry" beside a notice saying Undone. Seen red against the
 * operation that told the whisper nothing on that path (found at
 * review).
 */
describe("the whisper an inverse's failure raised is cleared when the inverse is over", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a Retry whose read finds the write landed says Undone and clears the failed state", async () => {
    const c = canvas();
    const edited = c.recording.edits.edit("n1", { input: "points", distance: 200, name: "n1" });
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 200, name: "n1" }), applied: "active" });
    await edited;
    const step = c.history().past[0] as RecipeStep;
    const undo = c.press("undo", step);
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 200, name: "n1" })] } });
    await c.w.settle();
    // The PATCH lands on the server, but the browser never hears the answer.
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].cut();
    await undo;
    expect(c.whispers.at(-1)?.kind).toBe("failed");
    const retry = c.retryOffered();
    expect(retry).not.toBeNull();
    retry!();
    await c.w.settle();
    // The fresh read shows the definition already back: nothing to send.
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("n1", { input: "points", distance: 100, name: "n1" })] } });
    await c.w.settle();
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
    expect(c.said.at(-1)).toBe("Undone: n1 edited");
    expect(c.history().future).toEqual([step]);
    // The frame no longer offers a Retry for a failure that is over.
    expect(c.whispers.at(-1)?.kind).toBe("saved");
  });
});

/**
 * A restoration whose order fails compensates by removing the node it
 * added, and the step stays for the next press. The order's failure
 * offered the frame's Retry; the compensating removal then said saving
 * and saved through the same whisper, erasing that Retry while the step
 * stood. Seen red against the operation that let the compensation's
 * success be the whisper's last word (found at review).
 */
describe("a failed order's Retry survives the compensation that follows it (behaviours 3 and 5)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the whisper's last word is the failure with its Retry, and the Retry restores the node again", async () => {
    const c = canvas();
    const step: RecipeStep = {
      kind: "recipe",
      nodeId: "old",
      watermarks: { old: null },
      op: { kind: "remove", operation: "buffer", parameters: { input: "points", distance: 100, name: "old" }, position: { x: 48, y: 40 }, ordinal: 0, dataset: "never" },
      label: "old removed",
    };
    c.seed({ ...EMPTY_HISTORY, past: [step] });
    const undo = c.press("undo", step);
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("other", { input: "points", distance: 5, name: "other" })] } });
    await c.w.settle();
    c.w.pending("POST", `/api/recipes/${W}/steps`)[0].ok({ step: stepOf("fresh", { input: "points", distance: 100, name: "old" }, 1) });
    await c.w.settle();
    // The order's request never hears an answer; the compensation lands.
    c.w.pending("POST", `/api/recipes/${W}/steps/fresh/move`)[0].cut();
    await c.w.settle();
    const compensation = c.w.pending("DELETE", `/api/recipes/${W}/steps/fresh`);
    expect(compensation).toHaveLength(1);
    compensation[0].ok({ removed: "fresh", output: null, readers: [], outputsRemain: false, message: "" });
    await undo;
    expect(c.said.at(-1)).toMatch(/^Not undone: /);
    expect(c.history().past).toEqual([step]);
    // The step is kept, so the whisper must still offer the Retry that
    // resumes it, not the compensation's "Saved".
    expect(c.whispers.at(-1)?.kind).toBe("failed");
    const retry = c.retryOffered();
    expect(retry).not.toBeNull();
    retry!();
    await c.w.settle();
    c.w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: { steps: [reading("other", { input: "points", distance: 5, name: "other" })] } });
    await c.w.settle();
    expect(c.w.pending("POST", `/api/recipes/${W}/steps`)).toHaveLength(1);
  });
});
