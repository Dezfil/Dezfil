import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "@/lib/assistant/loop";
import { emptyTurn, receiveEvent } from "./assistant-turn-state";
import { CONTINUING, TURN_STARTED, confirmationWords, eventAnnouncements, settlementAnnouncements, terminalWords } from "./turn-announcements";

/**
 * The announcement rule: the sentences the one status region carries,
 * authored here from the spec's list (turn start, each action's start
 * and outcome, the gate's target and consequence, the continuation, the
 * terminal outcome), sourced from the event sequence and the receipt
 * rather than from rendered snapshots,
 * nothing per token.
 */
const pending = { id: "p1", runId: "r1", tool: "delete_table", args: {}, confirmation: { target: "Delete the table parks_raw?", consequence: "Two layers on this map use it. They will stop drawing." } };
const events: AssistantEvent[] = [
  { type: "tool_call", id: "c1", tool: "run_sql", args: { sql: "SELECT 1" }, label: "Ran a query on parks" },
  { type: "tool_result", id: "c1", tool: "run_sql", ok: true, body: {}, outcome: "succeeded", label: "Ran a query on parks", elapsedMs: 200 },
  { type: "tool_result", id: "c2", tool: "update_layer", ok: false, body: { error: { code: "sql_error", message: "The column area_m2 is not on parks." } }, outcome: "refused", label: "Updated the layer parks" },
  { type: "confirm_required", id: "p1", tool: "delete_table", args: {}, confirmation: pending.confirmation },
  { type: "text_delta", messageId: "m", text: "The classes" },
];

/** The sentences the events produce when applied in order, whatever the render cadence. */
function sound(sequence: AssistantEvent[]): string[] {
  let turn = emptyTurn();
  const out: string[] = [];
  for (const event of sequence) { turn = receiveEvent(turn, event, "r1"); out.push(...eventAnnouncements(turn, event)); }
  return out;
}

describe("the announcements over a turn with two actions, a parked gate and a streamed answer", () => {
  it("say what the spec's list names, in order, from the events, and nothing for a token", () => {
    expect(TURN_STARTED).toBe("Working on your message.");
    expect(sound(events)).toEqual([
      "Ran a query on parks: in progress.",
      "Ran a query on parks: done, 0.2 s.",
      "Updated the layer parks: not done. The column area_m2 is not on parks.",
      "Confirmation required. Delete the table parks_raw? Two layers on this map use it. They will stop drawing.",
    ]);
    expect(CONTINUING).toBe("Continuing.");
    expect(terminalWords("completed")).toBe("Reply complete.");
  });
  it("a call and its result applied before any render still announce the start and the outcome, in order", () => {
    // Two events in one chunk: applied back to back, no render between.
    expect(sound(events.slice(0, 2))).toEqual(["Ran a query on parks: in progress.", "Ran a query on parks: done, 0.2 s."]);
  });
  it("a refusal that never ran announces its outcome alone, and a token announces nothing", () => {
    expect(sound([events[2]])).toEqual(["Updated the layer parks: not done. The column area_m2 is not on parks."]);
    expect(sound([events[4]])).toEqual([]);
  });
});

describe("settlement", () => {
  const done = { id: "c1", tool: "run_sql", label: "Ran a query on parks", status: "succeeded" as const, elapsed: "0.2 s", inputs: [], omitted: false };
  it("announces the outcomes the stream did not carry and the terminal outcome: a parked turn ended by Stop, a failure, an unavailable run", () => {
    const stoppedGate = { id: "confirmation:p1", tool: "delete_table", label: "Delete the table parks_raw", status: "refused" as const, inputs: [], omitted: false, decision: "superseded" as const, failure: { code: "stopped", message: "You stopped the request, so this was not done." } };
    expect(settlementAnnouncements([done], [done, stoppedGate], "interrupted")).toEqual(["Delete the table parks_raw: not done. You stopped the request, so this was not done.", "Request stopped."]);
    expect(settlementAnnouncements([done], [done], "completed")).toEqual(["Reply complete."]);
    expect(settlementAnnouncements([], [], "failed")).toEqual(["Request failed."]);
    expect(terminalWords("unavailable")).toBe("Request unavailable.");
    // A result the stream lost sounds at settlement; one it carried does not sound twice.
    const running = { ...done, status: "running" as const, elapsed: undefined };
    expect(settlementAnnouncements([running], [done], "completed")).toEqual(["Ran a query on parks: done, 0.2 s.", "Reply complete."]);
    expect(terminalWords("running")).toBeNull();
  });
  it("words the gate for the region", () => {
    expect(confirmationWords(pending)).toBe("Confirmation required. Delete the table parks_raw? Two layers on this map use it. They will stop drawing.");
  });
});
