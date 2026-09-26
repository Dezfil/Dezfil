import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePending, type Waiting } from "./panel-pending";

/**
 * The panel's pending send: a field's newest value replaces the one
 * waiting, and a change in another field, or in another focus session of
 * the same one, sends what waited first under its own field and session,
 * so one undo never reverts two sessions. Seen red against the slot that
 * carried both fields' changes under the second's session (found at
 * review; the verification record names the run).
 */

const DELAY = 400;

function slot() {
  const sent: Waiting[] = [];
  const pending = makePending(DELAY);
  pending.setDispatch((w) => sent.push(w));
  return { pending, sent };
}

describe("the panel's pending send", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a field's newer value replaces the one waiting, and one send goes after the delay", () => {
    const { pending, sent } = slot();
    pending.offer({ distance: 200 }, "distance", "s1");
    pending.offer({ distance: 250 }, "distance", "s1");
    vi.advanceTimersByTime(DELAY - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ values: { distance: 250 }, at: "distance", session: "s1" }]);
    expect(pending.waiting()).toBe(false);
  });

  it("a change in another field sends what waited first, under its own field and session, and waits its own delay", () => {
    const { pending, sent } = slot();
    pending.offer({ distance: 200, name: "a" }, "distance", "s1");
    vi.advanceTimersByTime(100);
    pending.offer({ distance: 200, name: "b" }, "name", "s2");
    // The distance's change went at once, under the distance's session.
    expect(sent).toEqual([{ values: { distance: 200, name: "a" }, at: "distance", session: "s1" }]);
    vi.advanceTimersByTime(DELAY - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      { values: { distance: 200, name: "a" }, at: "distance", session: "s1" },
      { values: { distance: 200, name: "b" }, at: "name", session: "s2" },
    ]);
  });

  it("the same field in a new focus session sends the earlier session's value first", () => {
    const { pending, sent } = slot();
    pending.offer({ distance: 200 }, "distance", "s1");
    pending.offer({ distance: 250 }, "distance", "s2");
    expect(sent).toEqual([{ values: { distance: 200 }, at: "distance", session: "s1" }]);
    vi.advanceTimersByTime(DELAY);
    expect(sent).toEqual([
      { values: { distance: 200 }, at: "distance", session: "s1" },
      { values: { distance: 250 }, at: "distance", session: "s2" },
    ]);
  });

  it("take empties the slot without sending, and nothing goes when the delay would have fired", () => {
    const { pending, sent } = slot();
    pending.offer({ distance: 200 }, "distance", "s1");
    expect(pending.waiting()).toBe(true);
    expect(pending.take()).toEqual({ values: { distance: 200 }, at: "distance", session: "s1" });
    expect(pending.waiting()).toBe(false);
    expect(pending.take()).toBeNull();
    vi.advanceTimersByTime(DELAY);
    expect(sent).toEqual([]);
  });
});
