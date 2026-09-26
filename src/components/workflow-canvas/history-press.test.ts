import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "../workflow-model";
import { EMPTY_HISTORY, words, type Definition, type Direction, type History, type RecipeStep, type Step } from "./canvas-history";
import { wire } from "./fetch-wire";
import { runPress, type PressScreen } from "./history-press";
import { makeRecording } from "./history-recording";
import type { SaveState } from "./use-layout-saves";
import { RecipeEditor, type RetryPorts } from "./use-recipe-edits";

/**
 * The press's pending work, on the real `RecipeEditor` over a fetch the
 * test answers by hand, with the real recording layer the panel's flush
 * travels: a pending panel value the API refuses, and an edit on the
 * wire refused while the press waits for it, each refuse the press with
 * the API's reason and leave the record intact, as a run over a rejected
 * save is refused (barrier). Seen red against the press that checked
 * only a failed flush and ignored the barrier's answer (found at review;
 * the verification record names the run).
 */

const W = "w3";
const REFUSED = "The result needs a name.";
const OPEN_RETRY_STUB = { lockReason: () => null, say: () => undefined } satisfies RetryPorts;

const stepOf = (id: string, parameters: Record<string, unknown>): WorkflowStep => ({
  id,
  ordinal: 0,
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
const def = (parameters: Record<string, unknown>): Definition => ({ parameters, proposedParameters: null });
/** A step already in the record: n1's distance edited from 100 to 200. */
const edited = (): RecipeStep => ({
  kind: "recipe",
  nodeId: "n1",
  watermarks: { n1: null },
  op: { kind: "edit", before: def({ input: "points", distance: 100, name: "n1" }), after: def({ input: "points", distance: 200, name: "n1" }), session: null },
  label: words.edited("n1"),
});

function canvas() {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  const whispers: SaveState[] = [];
  const editor = new RecipeEditor(W, { onState: (s) => whispers.push(s), onAccepted: () => undefined }, OPEN_RETRY_STUB);
  let history: History = { ...EMPTY_HISTORY, past: [edited()] };
  const known = new Map<string, Definition>([["n1", def({ input: "points", distance: 200, name: "n1" })]]);
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
  const applied: { step: Step; direction: Direction }[] = [];
  let settledSaves = 0;
  const screen: PressScreen = {
    lockReason: null,
    say: (text) => said.push(text),
    commitNoteEditor: () => undefined,
    flushPanel: () => Promise.resolve(null),
    settleLayoutSave: () => {
      settledSaves += 1;
    },
  };
  let sealed = 0;
  const press = (direction: Direction) =>
    runPress(direction, {
      screen: () => screen,
      edits: editor,
      record: () => history,
      seal: () => {
        sealed += 1;
      },
      apply: async (step, d) => {
        applied.push({ step, direction: d });
      },
    });
  return { w, recording, screen, said, applied, whispers, history: () => history, press, settledSaves: () => settledSaves, sealed: () => sealed };
}

describe("a press lands what is pending first, as a run does", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a pending panel value the API refuses refuses the press with the API's reason: nothing applied, the record intact", async () => {
    const c = canvas();
    // The panel's flush sends what is typed through the recording layer,
    // as the panel does; the API refuses it.
    c.screen.flushPanel = () => c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" }, { field: "distance", session: "s1" });
    const undo = c.press("undo");
    await c.w.settle();
    const patch = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`);
    expect(patch).toHaveLength(1);
    patch[0].refuse(400, "invalid_request", REFUSED);
    await undo;
    // The older step was not applied over the refused draft.
    expect(c.applied).toEqual([]);
    expect(c.said.at(-1)).toBe(`Not undone: ${REFUSED}`);
    expect(c.sealed()).toBe(0);
    // The refused value is no step, and the step before it stands untaken.
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited"]);
    expect(c.history().future).toEqual([]);
    expect(c.w.calls.filter((x) => !x.answered)).toEqual([]);
  });

  it("an edit on the wire refused while the press waits for it refuses the press with its reason", async () => {
    const c = canvas();
    // An edit made before the press, still on the wire when it arrives.
    const typed = c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" }, { field: "distance", session: "s1" });
    await c.w.settle();
    const undo = c.press("undo");
    await c.w.settle();
    // The press is waiting on the barrier: nothing applied yet.
    expect(c.applied).toEqual([]);
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].refuse(400, "invalid_request", REFUSED);
    expect((await typed).kind).toBe("refused");
    await undo;
    expect(c.applied).toEqual([]);
    expect(c.said.at(-1)).toBe(`Not undone: ${REFUSED}`);
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited"]);
  });

  it("a pending value the API accepts is the newest step, and the press takes it", async () => {
    const c = canvas();
    c.screen.flushPanel = () => c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" }, { field: "distance", session: "s1" });
    const undo = c.press("undo");
    await c.w.settle();
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 300, name: "n1" }), applied: "active" });
    await undo;
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "n1 edited"]);
    expect(c.applied).toHaveLength(1);
    expect(c.applied[0].step).toBe(c.history().past[1]);
    expect(c.settledSaves()).toBe(1);
    expect(c.sealed()).toBe(1);
  });
});

describe("the lock is met again after every wait", () => {
  afterEach(() => vi.unstubAllGlobals());
  const LOCK = "Canvas locked. Unlock to edit.";

  it("locked while the panel's flush is on the wire: the flushed value lands under its own outcome, and the press applies nothing and settles no save", async () => {
    const c = canvas();
    c.screen.flushPanel = () => c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" }, { field: "distance", session: "s1" });
    const undo = c.press("undo");
    await c.w.settle();
    const patch = c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`);
    expect(patch).toHaveLength(1);
    c.screen.lockReason = LOCK;
    patch[0].ok({ step: stepOf("n1", { input: "points", distance: 300, name: "n1" }), applied: "active" });
    await undo;
    expect(c.applied).toEqual([]);
    expect(c.settledSaves()).toBe(0);
    expect(c.said.at(-1)).toBe(LOCK);
    // The value sent before the lock is a step, as a move admitted before
    // the lock completes under its own outcome; the record is otherwise as it was.
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "n1 edited"]);
    expect(c.sealed()).toBe(0);
  });

  it("locked while the press waits for an edit on the wire: nothing is applied", async () => {
    const c = canvas();
    const typed = c.recording.edits.edit("n1", { input: "points", distance: 300, name: "n1" });
    await c.w.settle();
    const undo = c.press("undo");
    await c.w.settle();
    c.screen.lockReason = LOCK;
    c.w.pending("PATCH", `/api/recipes/${W}/steps/n1`)[0].ok({ step: stepOf("n1", { input: "points", distance: 300, name: "n1" }), applied: "active" });
    await typed;
    await undo;
    expect(c.applied).toEqual([]);
    expect(c.said.at(-1)).toBe(LOCK);
    expect(c.history().past.map((s) => s.label)).toEqual(["n1 edited", "n1 edited"]);
  });
});
