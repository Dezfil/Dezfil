import { describe, it, expect } from "vitest";
import { applyRecipeStep, type RecipePorts } from "./history-recipe";
import type { ReadStep } from "./history-inverses";
import { reasons, words, type RecipeStep } from "./canvas-history";
import type { EditOutcome, RecipeEdits, RemovalOutcome } from "./use-recipe-edits";
import type { WorkflowStep } from "../workflow-model";

/**
 * The recipe appliers, where a restoration is all or nothing: an order
 * the engine refuses takes the node just added back out, and until that
 * removal lands the step must stay in the record — dropping it would
 * leave the added node standing with nothing left to take it away, and
 * its Retry unable to clean up. Seen red against the applier that
 * returned the order's own drop verdict whatever became of the
 * compensation.
 */

const reading = (id: string, ordinal: number, name: string, operation = "filter_rows"): ReadStep => ({
  id,
  operation,
  ordinal,
  parameters: { name },
  proposedParameters: null,
  output: null,
  lastSuccessAt: null,
});

const stepOf = (id: string): WorkflowStep =>
  ({ id, ordinal: 1, operation: "buffer", parameters: { input: "points", name: "points_buffer" }, proposedParameters: null, output: null, lastSuccessAt: null }) as unknown as WorkflowStep;

/** A removal of a never-run node, taken back. */
const removal = (): RecipeStep => ({
  kind: "recipe",
  nodeId: "old",
  watermarks: { old: null },
  op: { kind: "remove", operation: "buffer", parameters: { input: "points", name: "points_buffer" }, position: { x: 48, y: 40 }, ordinal: 0, dataset: "never" },
  label: words.removed("Buffer"),
});

const ORDER_REFUSED = "A producer cannot stand after the nodes that read it.";
const REMOVE_FAILED = "Couldn't reach the server to remove the node.";

function ports({ removeAccepts = false }: { removeAccepts?: boolean } = {}) {
  const calls: string[] = [];
  const droppedTiles: string[] = [];
  const edits = {
    add: async () => {
      calls.push("add");
      return { kind: "accepted", step: stepOf("new") } as EditOutcome;
    },
    reorder: async () => {
      calls.push("reorder");
      return { kind: "refused", code: "invalid_request", message: ORDER_REFUSED, status: 400 } as EditOutcome;
    },
    remove: async () => {
      calls.push("remove");
      return (removeAccepts
        ? { kind: "accepted", answer: { removed: "new", output: null, readers: [], outputsRemain: false, message: "" } }
        : { kind: "failed", message: REMOVE_FAILED }) as RemovalOutcome;
    },
    edit: async () => ({ kind: "accepted", step: null }) as EditOutcome,
    discard: async () => ({ kind: "accepted", step: null }) as EditOutcome,
    idle: () => Promise.resolve(),
    settled: () => Promise.resolve(null),
  } as unknown as RecipeEdits;
  const forgotten: string[] = [];
  const p: RecipePorts = {
    edits,
    labelOf: (id) => id,
    stored: () => ({ new: { x: 48, y: 40 } }),
    dropNode: (id) => droppedTiles.push(id),
    answered: () => undefined,
    forget: (id) => forgotten.push(id),
  };
  return { p, calls, forgotten, droppedTiles };
}

describe("a restoration whose order is refused", () => {
  it("keeps the step while the node it added is still standing, and drops it once the compensation lands", async () => {
    const step = removal();
    const before = [reading("other", 0, "points_other")];
    const first = ports({});
    // The order is refused for good, and the compensating removal cannot
    // be sent: the node just added stands, so the step stays.
    const kept = await applyRecipeStep(step, "undo", before, first.p);
    expect(first.calls).toEqual(["add", "reorder", "remove"]);
    expect(kept).toEqual({ kind: "refused", failed: true, verdict: "keep", reason: REMOVE_FAILED });
    expect(first.forgotten).toEqual([]);

    // Retry, on a fresh read: the node this attempt created is adopted
    // rather than added again, the order is refused again, and this time
    // the compensation lands — now the step goes, with the order's reason.
    const after = [reading("other", 0, "points_other"), reading("new", 1, "points_buffer", "buffer")];
    const second = ports({ removeAccepts: true });
    const gone = await applyRecipeStep(step, "undo", after, second.p);
    expect(second.calls).toEqual(["reorder", "remove"]);
    expect(gone).toEqual({ kind: "refused", verdict: "drop", reason: ORDER_REFUSED });
    expect(second.forgotten).toEqual(["new"]);
  });
});

/** A never-run node added from the pane, taken back. */
const added = (): RecipeStep => ({
  kind: "recipe",
  nodeId: "new",
  watermarks: { new: null },
  op: { kind: "add", operation: "buffer", parameters: { input: "points", name: "points_buffer" }, position: { x: 48, y: 40 }, pasted: false },
  label: words.added("Buffer"),
});

describe("a node gone before the record's own removal (behaviours 2 and 3)", () => {
  it("on the first attempt, a node another tab or agent removed drops the step with the reason and sends nothing; on a resume after a lost answer, the removal has landed", async () => {
    const withoutNew = [reading("other", 0, "points_other")];
    const withNew = [reading("other", 0, "points_other"), reading("new", 1, "points_buffer", "buffer")];
    // The first press: the read already lacks the node. Nothing of this
    // record took it, so the step cannot pass; a redo of it would bring
    // back a node somebody else removed.
    const first = ports({});
    const step = added();
    expect(await applyRecipeStep(step, "undo", withoutNew, first.p)).toEqual({ kind: "refused", verdict: "drop", reason: reasons.gone("new") });
    expect(first.calls).toEqual([]);
    expect(first.droppedTiles).toEqual([]);
    // Another step: its removal is sent and its answer lost, and the
    // resume's fresh read lacks the node. That removal is the one that
    // took it: the stage has landed, and the tile leaves.
    const cut = ports({});
    const resumed = added();
    expect(await applyRecipeStep(resumed, "undo", withNew, cut.p)).toEqual({ kind: "refused", failed: true, verdict: "keep", reason: REMOVE_FAILED });
    expect(cut.calls).toEqual(["remove"]);
    const again = ports({});
    expect(await applyRecipeStep(resumed, "undo", withoutNew, again.p)).toEqual({ kind: "done" });
    expect(again.calls).toEqual([]);
    expect(again.droppedTiles).toEqual(["new"]);
  });
});
