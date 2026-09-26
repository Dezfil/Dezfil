import { describe, expect, it } from "vitest";
import { completedTurns, emptyTurn, receiveEvent, recoveredTurn } from "./assistant-turn-state";

describe("pane turn reconstruction", () => {
  it("replaces streamed text with its complete message once, including later messages", () => {
    let state = receiveEvent(emptyTurn(), { type: "text_delta", messageId: "a", text: "Ear" }, "run");
    expect(state.text).toBe("Ear");
    state = receiveEvent(state, { type: "text_delta", messageId: "a", text: "ly" }, "run");
    state = receiveEvent(state, { type: "message", messageId: "a", text: "Early" }, "run");
    state = receiveEvent(state, { type: "text_delta", messageId: "b", text: "Next" }, "run");
    state = receiveEvent(state, { type: "message", messageId: "b", text: "Next" }, "run");
    expect(state.text).toBe("Early\n\nNext");
    state = receiveEvent(state, { type: "message", messageId: "c", text: "Last" }, "run");
    expect(state.text).toBe("Early\n\nNext\n\nLast");
  });
  it("recovers exact pending identity and words, and commits successful download doors", () => {
    const pending = { id: "pending", runId: "run", tool: "publish_map", args: { id: "original" },
      confirmation: { target: "Publish Original (original)", consequence: "Make its data public." } };
    const state = recoveredTurn({ id: "run", state: "awaiting_confirmation", text: "Ready", incomplete: false, pending,
      actions: [{ id: "export", tool: "export_layer_data", args: { id: "layer", format: "csv" }, status: "succeeded" },
        { id: "failed-export", tool: "export_layer_data", args: { id: "other", format: "csv" }, status: "refused" }] });
    expect(state.pending).toEqual(pending);
    expect(completedTurns("run", "Export and publish", state)[1]).toMatchObject({ text: "Ready", downloads: [
      { kind: "layer", layerId: "layer", format: "csv" },
    ] });
    expect(completedTurns("run", "Export and publish", state)[1].downloads).toHaveLength(1);
  });
  it("keeps uncertainty, accepted job identity and unfinished work distinguishable", () => {
    const state = recoveredTurn({ id: "run", state: "interrupted", text: "", incomplete: false, actions: [
      { id: "u", tool: "create_map", status: "uncertain" },
      { id: "j", tool: "run_recipe", status: "accepted", jobId: "job-identity" },
      { id: "a", tool: "run_sql", status: "attempted" },
    ] });
    // The record's own vocabulary: each outcome reads distinctly.
    expect(state.actions.map((a) => a.status)).toEqual(["uncertain", "accepted", "running"]);
    expect(state.actions[0].failure?.message).toContain("uncertain");
    expect(state.actions[1].jobId).toBe("job-identity");
  });
});
