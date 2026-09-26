import { describe, it, expect } from "vitest";
import { classifyRefusal, definitionStage, relinkStages, removalStage, restoreStages, type ReadStep } from "./history-inverses";

/**
 * The inverse decisions (the plan's resumable inverses): what a fresh
 * read says has landed of an inverse of more than one request, which
 * identity a restored node takes, what remains to do; and which
 * refusals keep a step for the next press against which drop it. Pure:
 * a read in, a decision out, nothing applied. Seen red once against the
 * absent module (the verification record names the run).
 */

const T1 = "2026-08-29T10:00:00.000Z";
const step = (o: Partial<ReadStep> & { id: string }): ReadStep => ({
  operation: "buffer",
  ordinal: 0,
  parameters: { input: "points", distance: 100, name: "points_buffer" },
  proposedParameters: null,
  output: null,
  lastSuccessAt: null,
  ...o,
});
const def = (parameters: Record<string, unknown>, proposedParameters: Record<string, unknown> | null = null) => ({ parameters, proposedParameters });

describe("a definition written back", () => {
  it("a node gone from the workflow cannot take it; one already holding it has landed; otherwise the definition is written", () => {
    const read = [step({ id: "a", parameters: { input: "points", distance: 150, name: "points_buffer" } })];
    expect(definitionStage(read, "gone", def({ distance: 100 }))).toEqual({ stage: "gone" });
    expect(definitionStage(read, "a", def({ input: "points", distance: 150, name: "points_buffer" }))).toEqual({ stage: "landed" });
    expect(definitionStage(read, "a", def({ input: "points", distance: 100, name: "points_buffer" }))).toEqual({ stage: "write", parameters: { input: "points", distance: 100, name: "points_buffer" } });
  });

  it("on a node that has run, the definition it had comes back as the proposal it had, or as no proposal: a discard", () => {
    const active = { input: "points", distance: 100, name: "points_buffer" };
    const proposed = { input: "points", distance: 150, name: "points_buffer" };
    const ran = [step({ id: "a", parameters: active, proposedParameters: proposed, output: { id: "t1", name: "points_buffer" }, lastSuccessAt: T1 })];
    // Before the edit it had no proposal: the inverse is Discard edit.
    expect(definitionStage(ran, "a", def(active))).toEqual({ stage: "discard" });
    // Before the edit it had another proposal: that proposal is written, which the API keeps a
    // proposal.
    const older = { input: "points", distance: 120, name: "points_buffer" };
    expect(definitionStage(ran, "a", def(active, older))).toEqual({ stage: "write", parameters: older });
    // The proposal it had is back: landed.
    expect(definitionStage(ran, "a", def(active, proposed))).toEqual({ stage: "landed" });
    // No proposal now and none wanted: landed.
    const clean = [step({ id: "a", parameters: active, output: { id: "t1", name: "points_buffer" }, lastSuccessAt: T1 })];
    expect(definitionStage(clean, "a", def(active))).toEqual({ stage: "landed" });
  });
});

describe("a moved link goes back in two halves", () => {
  const holderBefore = def({ input: "points", distance: 100, name: "holder_out" });
  const holderAfter = def({ distance: 100, name: "holder_out" });
  const takerBefore = def({ distance: 50, name: "taker_out" });
  const takerAfter = def({ input: "points", distance: 50, name: "taker_out" });
  const halves = [
    { nodeId: "holder", target: holderBefore },
    { nodeId: "taker", target: takerBefore },
  ];

  it("the old holder's link first, then the moving node's detach; a half already true of the read is landed", () => {
    const moved = [step({ id: "holder", ...holderAfter }), step({ id: "taker", ordinal: 1, ...takerAfter })];
    expect(relinkStages(moved, halves)).toEqual([
      { nodeId: "holder", stage: { stage: "write", parameters: holderBefore.parameters } },
      { nodeId: "taker", stage: { stage: "write", parameters: takerBefore.parameters } },
    ]);
    // The first half landed under a lost answer: only the second remains.
    const half = [step({ id: "holder", ...holderBefore }), step({ id: "taker", ordinal: 1, ...takerAfter })];
    expect(relinkStages(half, halves)).toEqual([
      { nodeId: "holder", stage: { stage: "landed" } },
      { nodeId: "taker", stage: { stage: "write", parameters: takerBefore.parameters } },
    ]);
    // Both landed: nothing to do.
    const both = [step({ id: "holder", ...holderBefore }), step({ id: "taker", ordinal: 1, ...takerBefore })];
    expect(relinkStages(both, halves).map((h) => h.stage.stage)).toEqual(["landed", "landed"]);
    // The moving node gone since: its half cannot be applied; the holder's still can.
    expect(relinkStages([step({ id: "holder", ...holderAfter })], halves).map((h) => h.stage.stage)).toEqual(["write", "gone"]);
  });
});

describe("a removal undone comes back new, in its former place", () => {
  const reader = step({ id: "r", operation: "filter_rows", ordinal: 0, parameters: { input: "points_buffer", column: "name", op: "is_not_null", name: "points_filtered" } });
  // The ids the workflow held when the restoration began: the reader
  // alone, so a node the read shows beside it is one this attempt made.
  const want = { operation: "buffer", parameters: { input: "points", distance: 100, name: "points_buffer" }, ordinal: 0, position: { x: 48, y: 40 }, adopted: null, baseline: ["r"] };

  it("nothing in the read: add, then the order, then the position", () => {
    expect(restoreStages([reader], {}, want)).toEqual({ id: null, pending: ["add", "order", "place"] });
    // Its former place was the end: appending lands the order already.
    expect(restoreStages([reader], {}, { ...want, ordinal: 1 })).toEqual({ id: null, pending: ["add", "place"] });
    // A redo of an add has no place in the order to take, and no position until placed.
    expect(restoreStages([reader], {}, { ...want, ordinal: null })).toEqual({ id: null, pending: ["add", "place"] });
  });

  it("a node created under a lost answer is adopted by its operation and name, and only what is missing remains", () => {
    const appended = step({ id: "fresh", ordinal: 1 });
    expect(restoreStages([reader, appended], {}, want)).toEqual({ id: "fresh", pending: ["order", "place"] });
    const ordered = [step({ id: "fresh", ordinal: 0 }), { ...reader, ordinal: 1 }];
    expect(restoreStages(ordered, {}, want)).toEqual({ id: "fresh", pending: ["place"] });
    expect(restoreStages(ordered, { fresh: { x: 48, y: 40 } }, want)).toEqual({ id: "fresh", pending: [] });
    // The identity already adopted is kept even when its name has changed since.
    const renamed = [step({ id: "fresh", ordinal: 0, parameters: { input: "points", distance: 100, name: "other" } }), { ...reader, ordinal: 1 }];
    expect(restoreStages(renamed, {}, { ...want, adopted: "fresh" })).toEqual({ id: "fresh", pending: ["place"] });
    // Another operation declaring the same name is not it.
    const other = [step({ id: "sql", operation: "sql_step", ordinal: 1, parameters: { sql: "select 1", name: "points_buffer" } }), reader];
    expect(restoreStages(other, {}, want).id).toBeNull();
    // The name is matched as the API stores it, whatever the case typed.
    const cased = [step({ id: "fresh", ordinal: 0, parameters: { input: "points", distance: 100, name: "Points_Buffer" } })];
    expect(restoreStages(cased, {}, want).id).toBe("fresh");
  });

  it("a node that already stood when the restoration began is never adopted, whatever its operation and name", () => {
    // A node unrelated to this restoration that happens to carry the
    // removed node's operation and its name. It was in the workflow
    // before the undo began, so it is not one this attempt created:
    // adopting it would re-key the record onto somebody else's node.
    const standing = step({ id: "standing", parameters: { input: "points", distance: 100, name: "points_buffer" } });
    expect(restoreStages([standing], {}, { ...want, baseline: ["standing"] })).toEqual({ id: null, pending: ["add", "order", "place"] });
    // The same read, with that node absent when the restoration began:
    // it is the one the lost answer created, and it is adopted.
    expect(restoreStages([standing], {}, { ...want, baseline: [] })).toEqual({ id: "standing", pending: ["place"] });
  });

  it("a removal redone, and an add undone, remove the node; one already gone has landed", () => {
    expect(removalStage([reader, step({ id: "a", ordinal: 1 })], "a")).toBe("remove");
    expect(removalStage([reader], "a")).toBe("landed");
  });
});

describe("refusals: keep for the next press against drop with the reason", () => {
  it("keeps the step when the refusal will pass later: the server unreachable, the routes' changed-meanwhile conflict, a member of the run in flight, an invalid draft", () => {
    expect(classifyRefusal({ kind: "failed", message: "Could not reach the server to save the change." })).toEqual({ verdict: "keep", reason: "Could not reach the server to save the change." });
    expect(classifyRefusal({ kind: "refused", code: "invalid_request", status: 409, message: "This workflow changed while the edit was being checked. Try again." }).verdict).toBe("keep");
    expect(classifyRefusal({ kind: "refused", code: "run_in_flight", message: "Buffer is part of the run in flight. Link it once it settles." }).verdict).toBe("keep");
    expect(classifyRefusal({ kind: "refused", code: "invalid_draft", message: "Fix the distance first: A distance is more than 0 metres." }).verdict).toBe("keep");
    // The lock met at a request (found at review): unlocking finds the step.
    expect(classifyRefusal({ kind: "refused", code: "locked", message: "Canvas locked. Unlock to edit." }).verdict).toBe("keep");
  });

  it("drops the step when the refusal cannot pass: the name rule, the order rule, a backward read, a node no longer there", () => {
    const name = classifyRefusal({ kind: "refused", code: "invalid_request", status: 400, message: 'A table named "points_buffer" already exists. An operation never replaces or renames around an existing table. Choose another name.' });
    expect(name).toEqual({ verdict: "drop", reason: 'A table named "points_buffer" already exists. An operation never replaces or renames around an existing table. Choose another name.' });
    expect(classifyRefusal({ kind: "refused", code: "invalid_request", status: 400, message: "Step 2 reads points_buffer, which step 3 produces." }).verdict).toBe("drop");
    expect(classifyRefusal({ kind: "refused", code: "not_found", status: 404, message: 'No step with id "gone" in this recipe.' }).verdict).toBe("drop");
    // Without a status, the code decides: a plain refusal is permanent.
    expect(classifyRefusal({ kind: "refused", code: "invalid_request", message: "The result needs a name." }).verdict).toBe("drop");
  });
});
