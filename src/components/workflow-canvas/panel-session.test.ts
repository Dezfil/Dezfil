import { describe, it, expect } from "vitest";
import { makeSessions } from "./panel-session";

/**
 * A field's focus session, minted through the path the panel itself uses
 * rather than written by hand: the record's own test names sessions it
 * invents, so nothing there could have caught a session that never ends.
 */

/** Stand-ins for the panel's input elements: only their identity matters. */
const distance = { name: "distance" } as unknown as Element;
const label = { name: "name" } as unknown as Element;

describe("a field's focus session", () => {
  it("keeps one session while the field and the focused element stay put", () => {
    const sessions = makeSessions();
    const first = sessions.mint("distance", distance);
    expect(sessions.mint("distance", distance)).toBe(first);
    expect(sessions.mint("distance", distance)).toBe(first);
  });

  it("starts a new session for another field, and for the same field focused elsewhere", () => {
    const sessions = makeSessions();
    const first = sessions.mint("distance", distance);
    expect(sessions.mint("name", label)).not.toBe(first);
    expect(sessions.mint("distance", label)).not.toBe(first);
  });

  it("ends the session when focus leaves the element: the same field returned to is a second session", () => {
    const sessions = makeSessions();
    const first = sessions.mint("distance", distance);
    sessions.left(distance);
    const second = sessions.mint("distance", distance);
    expect(second).not.toBe(first);
    // And the second run holds together as the first did.
    expect(sessions.mint("distance", distance)).toBe(second);
  });

  it("ignores focus leaving anything else", () => {
    const sessions = makeSessions();
    const first = sessions.mint("distance", distance);
    sessions.left(label);
    sessions.left(null);
    expect(sessions.mint("distance", distance)).toBe(first);
  });
});
