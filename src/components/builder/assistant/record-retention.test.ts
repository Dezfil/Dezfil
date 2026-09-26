import { describe, expect, it } from "vitest";
import { completedTurns, recoveredTurn, type LiveTurn } from "./assistant-turn-state";
import { STOPPED_NOTE, SUPERSEDED_NOTE, wordStoppedGate } from "./record-projection";
import type { RunReceipt } from "@/lib/assistant/runs";

/**
 * The retained record. Two of task 1's reds: on the tree before the
 * piece a turn that settles keeps only its text, so the actions it
 * performed leave the transcript with it; and a receipt compacted
 * past terminal bound recovers its actions with no detail and no mark
 * that detail was omitted, so nothing tells the reader that what they
 * see is less than what ran.
 */

const live: LiveTurn = {
  text: "Renamed the layer.",
  pending: null,
  actions: [
    { id: "c1", tool: "run_sql", label: "Ran a query", sql: "SELECT count(*) FROM parks", status: "succeeded", inputs: [], omitted: false },
    { id: "c2", tool: "update_layer", label: "Updated the layer Parks", status: "succeeded", inputs: [["id", "l1"]], omitted: false },
    { id: "c3", tool: "update_map", label: "Updated the map M", status: "refused", inputs: [["id", "m1"]], omitted: false,
      failure: { code: "assistant_action_not_admitted", message: "The run's page context does not admit this operation." } },
  ],
};

describe("a settled turn keeps its entries", () => {
  it("the assistant turn carries the turn's read, mutation and refusal, in order, unduplicated", () => {
    const turns = completedTurns("run-1", "Rename the layer", live, { page: "builder" });
    const assistant = turns.find((t) => t.role === "assistant")!;
    // Seeded defect: completedTurns keeps text and downloads only, so a
    // settled turn has no entries at all.
    expect(assistant).toHaveProperty("entries");
    expect(assistant.entries?.map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
    expect(assistant.entries).toEqual(live.actions);
    expect(new Set(assistant.entries?.map((e) => e.id)).size).toBe(3);
    // A later turn leaves the earlier one's entries where they are.
    const later = [...turns, ...completedTurns("run-2", "And now?", { text: "Nothing more.", pending: null, actions: [] })];
    expect(later[1].entries?.map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
    expect(later[3].entries).toBeUndefined();
  });
});

describe("a trimmed receipt marks what it cannot show", () => {
  it("an action whose arguments the terminal bound dropped is marked omitted, with no empty SQL shown", () => {
    // The receipt as the terminal compaction writes it: the arguments gone
    // and the action marked, the text trimmed.
    const receipt: RunReceipt = {
      id: "run-2", state: "completed", text: "", incomplete: true,
      actions: [{ id: "c1", tool: "run_sql", status: "succeeded", label: "Ran a query", omitted: true }],
    };
    const recovered = recoveredTurn(receipt);
    expect(recovered.actions[0].sql).toBeUndefined();
    // Seeded defect: nothing on the recovered line says the detail was
    // omitted; it reads exactly like a call that carried no SQL.
    expect(recovered.actions[0]).toMatchObject({ omitted: true });
  });
});

describe("a parked turn ended by Stop settles its gate as not done, in the pane's words", () => {
  const receipt: RunReceipt = {
    id: "run-3", state: "interrupted", text: "", incomplete: false,
    actions: [{ id: "c2", tool: "update_layer", status: "succeeded", label: "Updated the layer Parks" }],
    confirmations: [{ id: "p1", runId: "run-3", tool: "publish_map", decision: "superseded", confirmation: { target: "Publish Evening (m1)?", consequence: "Anyone with the link can view it." } }],
  };
  it("the abandonment's receipt projects the gate as its own not-done entry after the completed work, worded for a stopped request when this pane stopped it", () => {
    const recovered = recoveredTurn(receipt);
    expect(recovered.actions.map((e) => e.id)).toEqual(["c2", "confirmation:p1"]);
    const worded = wordStoppedGate(recovered.actions, "p1");
    expect(worded.at(-1)).toMatchObject({ label: "Publish Evening (m1)", status: "refused", decision: "superseded", failure: { code: "stopped", message: STOPPED_NOTE } });
    // Earlier completed work is not claimed undone.
    expect(worded[0]).toMatchObject({ status: "succeeded" });
    expect(STOPPED_NOTE).not.toContain("\u2014");
  });
  it("read back without that knowledge, the same gate keeps the API's wording, which is true for a stop and for a newer message alike", () => {
    const recovered = recoveredTurn(receipt);
    expect(wordStoppedGate(recovered.actions, null).at(-1)).toMatchObject({ failure: { code: "superseded", message: SUPERSEDED_NOTE } });
    expect(wordStoppedGate(recovered.actions, "other").at(-1)).toMatchObject({ failure: { code: "superseded" } });
    expect(SUPERSEDED_NOTE).not.toMatch(/next message/);
  });
});
