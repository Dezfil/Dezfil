import { describe, it, expect } from "vitest";
import type { LayoutNote } from "./placement";
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  NOTHING_TO_REDO,
  NOTHING_TO_UNDO,
  diffLayout,
  done,
  dropped,
  layoutInverse,
  holds,
  next,
  notDone,
  reasons,
  record,
  rekeyed,
  seal,
  settled,
  taken,
  words,
  type History,
  type LayoutStep,
  type RecipeStep,
} from "./canvas-history";

/**
 * The record's rules, held on their own: the newest hundred in the order
 * made, one step back per press, the undone side forgotten by a fresh
 * step; a run of arrow keys on one member and a field's focus session
 * each one step until a boundary; an edit whose sides are equal and a
 * discard that dropped nothing are no step; a layout step as the
 * difference of two snapshots, undone for what is still there and dropped
 * when nothing is left; a run settling a member's recipe steps against
 * the last success each step carries; and every step following a node
 * that came back under a fresh identity. Seen red once against the absent
 * module (the verification record names the run).
 */

const at = (x: number, y: number) => ({ x, y });
const note = (id: string, o: Partial<LayoutNote> = {}): LayoutNote => ({ id, x: 0, y: 0, w: 160, h: 96, color: "yellow", text: "---\nlabel: note\n---\n", ...o });

/** A member moved from one spot to another, by a drag unless said. */
const move = (id: string, from: { x: number; y: number }, to: { x: number; y: number }, by: "drag" | "key" = "drag"): LayoutStep => ({
  kind: "layout",
  name: "move",
  by,
  delta: { members: [{ id, before: from, after: to }], notes: [] },
  label: words.moved(id),
});
const arrange = (moves: Record<string, [{ x: number; y: number }, { x: number; y: number }]>): LayoutStep => ({
  kind: "layout",
  name: "arrange",
  by: null,
  delta: { members: Object.entries(moves).map(([id, [before, after]]) => ({ id, before, after })), notes: [] },
  label: words.arrange,
});
const def = (parameters: Record<string, unknown>, proposedParameters: Record<string, unknown> | null = null) => ({ parameters, proposedParameters });
const edit = (nodeId: string, before: Record<string, unknown>, after: Record<string, unknown>, session: string | null = null, watermark: string | null = null): RecipeStep => ({
  kind: "recipe",
  nodeId,
  watermarks: { [nodeId]: watermark },
  op: { kind: "edit", before: def(before), after: def(after), session },
  label: words.edited("Buffer"),
});
const add = (nodeId: string): RecipeStep => ({
  kind: "recipe",
  nodeId,
  watermarks: { [nodeId]: null },
  op: { kind: "add", operation: "buffer", parameters: { input: "points", distance: 100, name: "points_buffer" }, position: at(48, 40), pasted: false },
  label: words.added("Buffer"),
});
/** A press that takes the newest step of its side, which is what every
 * press does when nothing lands while its inverse is on the wire. */
const take = (h: History, direction: "undo" | "redo") => taken(h, direction, next(h, direction)!);
const drop = (h: History, direction: "undo" | "redo") => dropped(h, direction, next(h, direction)!);
const labels = (h: History) => ({ past: h.past.map((s) => s.label), future: h.future.map((s) => s.label) });
const recordAll = (steps: (LayoutStep | RecipeStep)[], from: History = EMPTY_HISTORY) => steps.reduce((h, s) => record(h, s), from);

describe("the record", () => {
  it("keeps the steps in the order made and takes back the newest first; a redo restores the newest undone", () => {
    const h = recordAll([move("a", at(0, 0), at(8, 0)), move("b", at(0, 0), at(0, 8)), arrange({ a: [at(8, 0), at(48, 40)] })]);
    expect(next(h, "undo")?.label).toBe(words.arrange);
    expect(next(h, "redo")).toBeNull();
    const one = take(h, "undo");
    expect(next(one, "undo")?.label).toBe(words.moved("b"));
    expect(next(one, "redo")?.label).toBe(words.arrange);
    const two = take(one, "undo");
    expect(labels(two)).toEqual({ past: [words.moved("a")], future: [words.arrange, words.moved("b")] });
    const back = take(two, "redo");
    expect(next(back, "undo")?.label).toBe(words.moved("b"));
    expect(next(back, "redo")?.label).toBe(words.arrange);
  });

  it("holds the newest hundred: the oldest leaves when the hundred and first arrives", () => {
    const steps = Array.from({ length: HISTORY_LIMIT + 3 }, (_, i) => move(`m${i}`, at(0, 0), at(8 * (i + 1), 0)));
    const h = recordAll(steps);
    expect(HISTORY_LIMIT).toBe(100);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].label).toBe(words.moved("m3"));
    expect(h.past[h.past.length - 1].label).toBe(words.moved(`m${HISTORY_LIMIT + 2}`));
  });

  it("a fresh step forgets the undone ones (open question 2, decided)", () => {
    const h = take(take(recordAll([move("a", at(0, 0), at(8, 0)), move("b", at(0, 0), at(0, 8))]), "undo"), "undo");
    expect(h.future).toHaveLength(2);
    const fresh = record(h, arrange({ a: [at(0, 0), at(48, 40)] }));
    expect(labels(fresh)).toEqual({ past: [words.arrange], future: [] });
  });

  it("a step that cannot pass is dropped from its side and the next press takes the one before it", () => {
    const h = recordAll([move("a", at(0, 0), at(8, 0)), edit("n1", { distance: 100 }, { distance: 200 })]);
    const after = drop(h, "undo");
    expect(labels(after)).toEqual({ past: [words.moved("a")], future: [] });
    expect(next(after, "undo")?.label).toBe(words.moved("a"));
    // The same on the redo side.
    const undone = take(take(h, "undo"), "undo");
    const cut = drop(undone, "redo");
    expect(labels(cut)).toEqual({ past: [], future: [edit("n1", {}, {}).label] });
  });

  it("crosses the step the inverse applied, not whatever is newest when the answer lands", () => {
    // A recipe inverse is one or more round trips, and the canvas stays
    // editable while they are on the wire: the panel's debounce fires and
    // its edit becomes a step of its own before the answer comes back. The
    // step that crosses must be the one the workflow actually took back.
    const first = move("a", at(0, 0), at(8, 0));
    const applied = edit("n1", { distance: 100 }, { distance: 200 });
    // Its own label, so the record's two edits can be told apart: a check
    // that reads the same word either way decides nothing.
    const meanwhile = { ...edit("n2", { distance: 10 }, { distance: 20 }), label: words.edited("Centroid") };
    const h = record(recordAll([first, applied]), meanwhile);
    const after = taken(h, "undo", applied);
    expect(labels(after)).toEqual({ past: [first.label, meanwhile.label], future: [applied.label] });
    // The redo of that same step goes back where it was, over the step
    // that landed meanwhile.
    expect(labels(taken(after, "redo", applied))).toEqual({ past: [first.label, meanwhile.label, applied.label], future: [] });
  });

  it("drops the step the inverse was refused, not whatever is newest when the refusal lands", () => {
    const first = move("a", at(0, 0), at(8, 0));
    const refused = edit("n1", { distance: 100 }, { distance: 200 });
    const meanwhile = { ...edit("n2", { distance: 10 }, { distance: 20 }), label: words.edited("Centroid") };
    const h = record(recordAll([first, refused]), meanwhile);
    const after = dropped(h, "undo", refused);
    expect(labels(after)).toEqual({ past: [first.label, meanwhile.label], future: [] });
  });

  it("a step a run settled away while its inverse was on the wire crosses nothing", () => {
    const gone = edit("n1", { distance: 100 }, { distance: 200 }, null, null);
    const h = recordAll([move("a", at(0, 0), at(8, 0))]);
    expect(taken(h, "undo", gone)).toBe(h);
    expect(dropped(h, "undo", gone)).toBe(h);
    expect(holds(h, "undo", gone)).toBe(false);
    expect(holds(h, "undo", h.past[0])).toBe(true);
  });

  it("the empty record answers nothing on either side, in the notice's words", () => {
    expect(next(EMPTY_HISTORY, "undo")).toBeNull();
    expect(next(EMPTY_HISTORY, "redo")).toBeNull();
    expect(NOTHING_TO_UNDO).toBe("Nothing to undo");
    expect(NOTHING_TO_REDO).toBe("Nothing to redo");
  });
});

describe("what is one step (behaviours 2 and 3)", () => {
  it("arrow-key presses on the same selected member merge into one step, from the first's start to the last's end", () => {
    const h = recordAll([move("a", at(0, 0), at(8, 0), "key"), move("a", at(8, 0), at(16, 0), "key"), move("a", at(16, 0), at(24, 0), "key")]);
    expect(h.past).toHaveLength(1);
    const step = h.past[0] as LayoutStep;
    expect(step.delta.members).toEqual([{ id: "a", before: at(0, 0), after: at(24, 0) }]);
  });

  it("two members moved in turn are two steps; a drag never merges with a key run; a run that returns to its start is no step", () => {
    const two = recordAll([move("a", at(0, 0), at(8, 0), "key"), move("b", at(0, 0), at(8, 0), "key")]);
    expect(two.past).toHaveLength(2);
    const dragged = recordAll([move("a", at(0, 0), at(8, 0), "key"), move("a", at(8, 0), at(80, 40), "drag"), move("a", at(80, 40), at(88, 40), "key")]);
    expect(dragged.past.map((s) => (s as LayoutStep).by)).toEqual(["key", "drag", "key"]);
    const back = recordAll([move("a", at(0, 0), at(8, 0), "key"), move("a", at(8, 0), at(0, 0), "key")]);
    expect(back.past).toHaveLength(0);
  });

  it("a boundary between two arrow runs on one member splits them: a selection change, a pointer press, or a press of undo", () => {
    const sealedBetween = recordAll([move("a", at(8, 0), at(16, 0), "key")], seal(recordAll([move("a", at(0, 0), at(8, 0), "key")])));
    expect(sealedBetween.past).toHaveLength(2);
    // An undo taken between two runs is a boundary too.
    const undone = take(recordAll([move("a", at(0, 0), at(8, 0), "key")]), "undo");
    const again = record(take(undone, "redo"), move("a", at(8, 0), at(16, 0), "key"));
    expect(again.past).toHaveLength(2);
    // Another step between them splits them as well.
    const between = recordAll([move("a", at(0, 0), at(8, 0), "key"), move("b", at(0, 0), at(0, 8), "drag"), move("a", at(8, 0), at(16, 0), "key")]);
    expect(between.past).toHaveLength(3);
  });

  it("a field's accepted edits in one focus session are one step; another session, another node or a step between makes a new one", () => {
    const one = recordAll([edit("n1", { distance: 100 }, { distance: 1 }, "s1"), edit("n1", { distance: 1 }, { distance: 15 }, "s1"), edit("n1", { distance: 15 }, { distance: 150 }, "s1")]);
    expect(one.past).toHaveLength(1);
    const op = (one.past[0] as RecipeStep).op;
    expect(op.kind === "edit" && [op.before.parameters, op.after.parameters]).toEqual([{ distance: 100 }, { distance: 150 }]);
    const sessions = recordAll([edit("n1", { distance: 100 }, { distance: 150 }, "s1"), edit("n1", { distance: 150 }, { distance: 200 }, "s2")]);
    expect(sessions.past).toHaveLength(2);
    const nodes = recordAll([edit("n1", { distance: 100 }, { distance: 150 }, "s1"), edit("n2", { distance: 100 }, { distance: 150 }, "s1")]);
    expect(nodes.past).toHaveLength(2);
    const between = recordAll([edit("n1", { distance: 100 }, { distance: 150 }, "s1"), move("n1", at(0, 0), at(8, 0)), edit("n1", { distance: 150 }, { distance: 200 }, "s1")]);
    expect(between.past).toHaveLength(3);
    // A session typed back to where it started is no step.
    const returned = recordAll([edit("n1", { distance: 100 }, { distance: 150 }, "s1"), edit("n1", { distance: 150 }, { distance: 100 }, "s1")]);
    expect(returned.past).toHaveLength(0);
  });

  it("an edit whose two sides are equal, a discard that dropped nothing, and a layout offer that changed nothing are no step", () => {
    const same = record(EMPTY_HISTORY, edit("n1", { distance: 100 }, { distance: 100 }));
    expect(same.past).toHaveLength(0);
    const discard: RecipeStep = { kind: "recipe", nodeId: "n1", watermarks: { n1: null }, op: { kind: "discard", before: def({ distance: 100 }), after: def({ distance: 100 }) }, label: words.discarded("Buffer") };
    expect(record(EMPTY_HISTORY, discard).past).toHaveLength(0);
    const dropping: RecipeStep = { ...discard, op: { kind: "discard", before: def({ distance: 100 }, { distance: 200 }), after: def({ distance: 100 }) } };
    expect(record(EMPTY_HISTORY, dropping).past).toHaveLength(1);
    const nothing: LayoutStep = { kind: "layout", name: "arrange", by: null, delta: { members: [], notes: [] }, label: words.arrange };
    expect(record(EMPTY_HISTORY, nothing).past).toHaveLength(0);
  });
});

describe("a layout step is the difference of two snapshots", () => {
  const before = { positions: { a: at(0, 0), b: at(0, 200), "src:points": at(-200, 0) }, notes: [note("n1"), note("n2", { y: 300 })] };

  it("names the members moved, placed and removed and the notes touched with their place in the order; nothing when nothing changed", () => {
    expect(diffLayout(before, before)).toBeNull();
    const after = {
      positions: { a: at(48, 40), b: at(0, 200), "src:flat": at(-200, 200) },
      notes: [note("n2", { y: 300, color: "blue" }), note("n3", { x: 500 })],
    };
    expect(diffLayout(before, after)).toEqual({
      members: [
        { id: "a", before: at(0, 0), after: at(48, 40) },
        { id: "src:points", before: at(-200, 0), after: null },
        { id: "src:flat", before: null, after: at(-200, 200) },
      ],
      notes: [
        { id: "n1", before: { index: 0, note: note("n1") }, after: null },
        { id: "n2", before: { index: 1, note: note("n2", { y: 300 }) }, after: { index: 0, note: note("n2", { y: 300, color: "blue" }) } },
        { id: "n3", before: null, after: { index: 1, note: note("n3", { x: 500 }) } },
      ],
    });
  });

  it("undone, it writes back what it changed and nothing else: what was done since stays where it is", () => {
    const step = arrange({ a: [at(0, 0), at(48, 40)], b: [at(0, 200), at(48, 182)] });
    // Since the Arrange, b was dragged and a source was placed.
    const current = { positions: { a: at(48, 40), b: at(300, 300), "src:points": at(-200, 0) }, notes: [note("n1")] };
    const inverse = layoutInverse(step, "undo", current);
    expect(inverse).not.toBeNull();
    expect(inverse!.positions).toEqual({ a: at(0, 0), b: at(0, 200), "src:points": at(-200, 0) });
    expect(inverse!.notes).toEqual([note("n1")]);
    expect(inverse!.leftOut).toEqual([]);
    // Redone, the other side.
    expect(layoutInverse(step, "redo", { ...current, positions: inverse!.positions })!.positions).toEqual({ a: at(48, 40), b: at(48, 182), "src:points": at(-200, 0) });
  });

  it("a member or a note the step touched that is gone is left out; a step with nothing left is dropped", () => {
    const step = arrange({ a: [at(0, 0), at(48, 40)], b: [at(0, 200), at(48, 182)] });
    const bGone = layoutInverse(step, "undo", { positions: { a: at(48, 40) }, notes: [] });
    expect(bGone!.positions).toEqual({ a: at(0, 0) });
    expect(bGone!.leftOut).toEqual(["b"]);
    expect(layoutInverse(step, "undo", { positions: { c: at(1, 1) }, notes: [] })).toBeNull();
    const noteMoved: LayoutStep = { kind: "layout", name: "note_moved", by: null, delta: { members: [], notes: [{ id: "n1", before: { index: 0, note: note("n1") }, after: { index: 0, note: note("n1", { x: 80 }) } }] }, label: words.note.moved };
    expect(layoutInverse(noteMoved, "undo", { positions: {}, notes: [note("n2")] })).toBeNull();
  });

  it("a placed source undone leaves; a removed one undone comes back at its position, by the placement road; a removed note returns at its former index", () => {
    const placed: LayoutStep = { kind: "layout", name: "source_placed", by: null, delta: { members: [{ id: "src:flat", before: null, after: at(10, 10) }], notes: [] }, label: words.sourcePlaced("flat") };
    const current = { positions: { a: at(0, 0), "src:flat": at(10, 10) }, notes: [note("n1"), note("n3")] };
    const out = layoutInverse(placed, "undo", current)!;
    expect(out.positions).toEqual({ a: at(0, 0) });
    expect(out.dropped).toEqual(["src:flat"]);
    expect(out.restored).toEqual([]);
    const back = layoutInverse(placed, "redo", { ...current, positions: out.positions })!;
    expect(back.restored).toEqual([{ id: "src:flat", position: at(10, 10) }]);
    expect(back.positions["src:flat"]).toEqual(at(10, 10));
    const noteRemoved: LayoutStep = { kind: "layout", name: "note_removed", by: null, delta: { members: [], notes: [{ id: "n2", before: { index: 1, note: note("n2", { color: "blue" }) }, after: null }] }, label: words.note.removed };
    expect(layoutInverse(noteRemoved, "undo", current)!.notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(layoutInverse(noteRemoved, "undo", current)!.notes[1]).toEqual(note("n2", { color: "blue" }));
  });
});

describe("a run settles a member's recipe steps (open question 1)", () => {
  const T1 = "2026-08-29T10:00:00.000Z";
  const T2 = "2026-08-29T10:05:00.000Z";

  it("a member whose last success advanced past a step's watermark drops that step from both sides; one that did not run keeps them; layout steps stay", () => {
    const h = take(recordAll([move("n1", at(0, 0), at(8, 0)), edit("n1", { distance: 100 }, { distance: 150 }, null, null), edit("n2", { distance: 100 }, { distance: 150 }, null, T1), edit("n1", { distance: 150 }, { distance: 200 }, "s9", null)]), "undo");
    expect(labels(h).future).toHaveLength(1);
    const ran = settled(h, [
      { id: "n1", lastSuccessAt: T1 },
      { id: "n2", lastSuccessAt: T1 },
    ]);
    expect(ran.past.map((s) => [s.kind, (s as RecipeStep).nodeId ?? null])).toEqual([
      ["layout", null],
      ["recipe", "n2"],
    ]);
    expect(ran.future).toEqual([]);
    // n2 then writes again: its step leaves too.
    expect(settled(ran, [{ id: "n2", lastSuccessAt: T2 }]).past).toHaveLength(1);
  });

  it("a member absent from the read, a failed or a cancelled member (no new success) keeps its steps", () => {
    const h = recordAll([edit("n1", { distance: 100 }, { distance: 150 }, null, T1), edit("gone", { distance: 1 }, { distance: 2 }, null, null)]);
    expect(settled(h, [{ id: "n1", lastSuccessAt: T1 }]).past).toHaveLength(2);
    expect(settled(h, [{ id: "n1", lastSuccessAt: null }]).past).toHaveLength(2);
  });

  it("a step naming two nodes leaves when either wrote its dataset", () => {
    const relink: RecipeStep = {
      kind: "recipe",
      nodeId: "taker",
      watermarks: { taker: null, holder: T1 },
      op: { kind: "relink", holder: { nodeId: "holder", before: def({ input: "points" }), after: def({}) }, taker: { nodeId: "taker", before: def({}), after: def({ input: "points" }) } },
      label: words.linkMoved("Buffer"),
    };
    const h = record(EMPTY_HISTORY, relink);
    expect(settled(h, [{ id: "holder", lastSuccessAt: T1 }]).past).toHaveLength(1);
    expect(settled(h, [{ id: "holder", lastSuccessAt: T2 }]).past).toHaveLength(0);
    expect(settled(h, [{ id: "taker", lastSuccessAt: T1 }]).past).toHaveLength(0);
  });
});

describe("the record follows a node that came back", () => {
  it("re-keys every step naming the old identity: moves, edits, the removal itself, and the watermark's key", () => {
    const remove: RecipeStep = {
      kind: "recipe",
      nodeId: "old",
      watermarks: { old: null },
      op: { kind: "remove", operation: "buffer", parameters: { input: "points", distance: 100, name: "points_buffer" }, position: at(48, 40), ordinal: 0, dataset: "never" },
      label: words.removed("Buffer"),
    };
    const h = take(recordAll([move("old", at(0, 0), at(48, 40)), edit("old", { distance: 100 }, { distance: 150 }), arrange({ old: [at(48, 40), at(96, 40)], other: [at(0, 0), at(96, 182)] }), remove]), "undo");
    const fresh = rekeyed(h, "old", "new");
    expect((fresh.past[0] as LayoutStep).delta.members[0].id).toBe("new");
    expect((fresh.past[1] as RecipeStep).nodeId).toBe("new");
    expect((fresh.past[1] as RecipeStep).watermarks).toEqual({ new: null });
    expect((fresh.past[2] as LayoutStep).delta.members.map((m) => m.id)).toEqual(["new", "other"]);
    expect((fresh.future[0] as RecipeStep).nodeId).toBe("new");
    // A step naming another node is untouched.
    expect(rekeyed(record(EMPTY_HISTORY, add("x")), "old", "new").past[0]).toEqual(add("x"));
  });
});

describe("the words", () => {
  it("names the step, with no em dash anywhere", () => {
    expect(done("undo", arrange({}))).toBe("Undone: Arrange");
    expect(done("redo", move("Buffer", at(0, 0), at(8, 0)))).toBe("Redone: Buffer moved");
    expect(done("undo", { kind: "recipe", nodeId: "n", watermarks: {}, op: { kind: "edit", before: def({}), after: def({ input: "x" }), session: null }, label: words.linked("Filter rows") })).toBe("Undone: link to Filter rows");
    expect(notDone("undo", "Buffer is running")).toBe("Not undone: Buffer is running");
    expect(notDone("redo", "Buffer is running")).toBe("Not redone: Buffer is running");
    const every = [
      words.arrange, words.moved("Buffer"), words.sourcePlaced("points"), words.sourceRemoved("points"),
      ...Object.values(words.note), words.added("Buffer"), words.pasted("Buffer"), words.removed("Buffer"),
      words.linked("Buffer"), words.linkMoved("Buffer"), words.detached("Buffer"), words.edited("Buffer"), words.renamed("Buffer"), words.discarded("Buffer"),
      ...Object.values(reasons).map((r) => (typeof r === "string" ? r : r("Buffer", "running"))),
      NOTHING_TO_UNDO, NOTHING_TO_REDO,
    ];
    for (const w of every) expect(w).not.toContain("—");
  });
});
