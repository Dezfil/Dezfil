import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, expect, it } from "vitest";
import { PendingActionStore, type ParkedRun } from "./pending";

/**
 * The pending-action store: at-most-once resolution, a distinct
 * already-resolved answer, implicit decline by supersede, and honest bounds:
 * open capacity refuses admission; only resolved trace entries age out to
 * unknown, never to a replay.
 */

function parkedRun(): Omit<ParkedRun, "accountId"> {
  return {
    exchange: {
      async send() {
        throw new Error("unused");
      },
      async continueWith() {
        throw new Error("unused");
      },
    },
    calls: [{ id: "x1", name: "delete_table", args: { name: "parks" } }],
    index: 0,
    outcomes: [],
    steps: 1,
    headers: { "X-Change-Group": "g" },
    policy: "full",
  };
}

describe("PendingActionStore", () => {
  it("claims a parked run exactly once and traces the disposition", () => {
    const store = new PendingActionStore();
    const id = store.park(testAccountScope(), parkedRun());

    expect(store.resolutionOf(testAccountScope(), id)).toBeUndefined();
    expect(store.claim(testAccountScope(), id, "approved")).toBeDefined();
    // The second claim finds only the trace — at-most-once execution.
    expect(store.claim(testAccountScope(), id, "approved")).toBeUndefined();
    expect(store.resolutionOf(testAccountScope(), id)).toBe("approved");
  });

  it("a declined claim traces as declined", () => {
    const store = new PendingActionStore();
    const id = store.park(testAccountScope(), parkedRun());
    expect(store.claim(testAccountScope(), id, "declined")).toBeDefined();
    expect(store.resolutionOf(testAccountScope(), id)).toBe("declined");
  });

  it("supersede is an implicit decline that blocks later approval", () => {
    const store = new PendingActionStore();
    const id = store.park(testAccountScope(), parkedRun());
    store.supersede(testAccountScope(), id);
    expect(store.claim(testAccountScope(), id, "approved")).toBeUndefined();
    expect(store.resolutionOf(testAccountScope(), id)).toBe("superseded");
  });

  it("superseding an unknown id is a no-op, not an error", () => {
    const store = new PendingActionStore();
    store.supersede(testAccountScope(), "never-issued");
    expect(store.resolutionOf(testAccountScope(), "never-issued")).toBeUndefined();
  });

  it("an unknown id answers with nothing — no trace, no run", () => {
    const store = new PendingActionStore();
    expect(store.claim(testAccountScope(), "never-issued", "approved")).toBeUndefined();
    expect(store.resolutionOf(testAccountScope(), "never-issued")).toBeUndefined();
  });

  it("refuses admission at eight and preserves every open action", () => {
    const store = new PendingActionStore();
    const ids = Array.from({ length: 8 }, () => store.park(testAccountScope(), parkedRun()));
    expect(() => store.park(testAccountScope(), parkedRun())).toThrow("Eight assistant runs");
    for (const id of ids) expect(store.claim(testAccountScope(), id, "approved")).toBeDefined();
  });

  it("the resolved trace is bounded — the oldest disposition falls off", () => {
    const store = new PendingActionStore();
    const first = store.park(testAccountScope(), parkedRun());
    store.claim(testAccountScope(), first, "approved");
    for (let i = 0; i < 256; i += 1) {
      store.claim(testAccountScope(), store.park(testAccountScope(), parkedRun()), "declined");
    }
    expect(store.resolutionOf(testAccountScope(), first)).toBeUndefined();
  });
});
