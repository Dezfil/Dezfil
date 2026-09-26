import { describe, expect, it } from "vitest";
import { composerWorking, showsCaret, showsIndicator, showsStop, turnPhase } from "./turn-phase";

/** The pane's phases and the indicator rules:
 * execution and a parked card wear the running controls, a recovery read
 * the ordinary ones; the indicator's presence and absence by the spec's
 * list; the caret on the active segment only. */
const pending = { id: "p", runId: "r", tool: "publish_map", args: {} };
const running = { id: "c", tool: "run_sql", label: "Ran a query", status: "running" as const, inputs: [], omitted: false };
const done = { ...running, status: "succeeded" as const };

describe("the phase", () => {
  it("is executing while a submission or resolution flies, parked while a card waits, reading during a recovery read, idle otherwise", () => {
    expect(turnPhase({ busy: true, reading: false, pending: null })).toBe("executing");
    expect(turnPhase({ busy: true, reading: false, pending })).toBe("executing");
    expect(turnPhase({ busy: false, reading: false, pending })).toBe("parked");
    expect(turnPhase({ busy: true, reading: true, pending: null })).toBe("reading");
    expect(turnPhase({ busy: false, reading: false, pending: null })).toBe("idle");
  });
  it("puts Stop in the slot and Working… on the composer for execution and a parked card only", () => {
    expect(showsStop("executing")).toBe(true);
    expect(showsStop("parked")).toBe(true);
    expect(showsStop("reading")).toBe(false);
    expect(showsStop("idle")).toBe(false);
    expect(composerWorking("parked")).toBe(true);
    expect(composerWorking("reading")).toBe(false);
  });
});

describe("the indicator and the caret", () => {
  it("shows the indicator before the first action or word and between settled actions and the first word", () => {
    expect(showsIndicator({ phase: "executing", text: "", entries: [], pending: null, streaming: false })).toBe(true);
    expect(showsIndicator({ phase: "executing", text: "", entries: [done], pending: null, streaming: false })).toBe(true);
  });
  it("hides it during a running action, while parked, once text shows, and outside execution", () => {
    expect(showsIndicator({ phase: "executing", text: "", entries: [running], pending: null, streaming: false })).toBe(false);
    expect(showsIndicator({ phase: "parked", text: "", entries: [done], pending, streaming: false })).toBe(false);
    expect(showsIndicator({ phase: "executing", text: "", entries: [], pending, streaming: false })).toBe(false);
    expect(showsIndicator({ phase: "executing", text: "First words", entries: [], pending: null, streaming: true })).toBe(false);
    expect(showsIndicator({ phase: "reading", text: "", entries: [], pending: null, streaming: false })).toBe(false);
    expect(showsIndicator({ phase: "idle", text: "", entries: [], pending: null, streaming: false })).toBe(false);
  });
  it("puts the caret on shown text while its delta stream is open, during execution only", () => {
    expect(showsCaret({ phase: "executing", text: "Some", entries: [], pending: null, streaming: true })).toBe(true);
    expect(showsCaret({ phase: "executing", text: "Some", entries: [], pending: null, streaming: false })).toBe(false);
    expect(showsCaret({ phase: "executing", text: "", entries: [], pending: null, streaming: true })).toBe(false);
    expect(showsCaret({ phase: "parked", text: "Some", entries: [], pending, streaming: true })).toBe(false);
  });
});
