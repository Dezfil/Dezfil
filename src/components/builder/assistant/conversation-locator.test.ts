import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationStore } from "./conversation-store";

/**
 * The reload locator. Task 1's red: the conversation store is memory
 * only, so a reload during a live run loses the run's identity and the
 * turn that started it: the message the person sent, the page it came
 * from and, on /sql, the draft the proposal's Insert compares against
 * (D1, D8).
 *
 * A reload is modelled as a second store instance over the same tab's
 * session storage; the first instance is the page before the reload.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => { map.delete(key); },
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

describe("the active run and its originating turn survive a reload; settlement clears them", () => {
  beforeEach(() => { vi.stubGlobal("sessionStorage", memoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a second store over the same tab finds the run, the message, the page and the draft snapshot", () => {
    const before = new ConversationStore();
    before.active = { id: "run-7", message: "Which parks are near a station?", origin: { page: "sql", draft: "SELECT 1;" } };
    // Seeded defect: the identity and the originating turn live in the
    // module's memory alone, so the reloaded page's store starts empty.
    const after = new ConversationStore();
    expect(after.active).toEqual({ id: "run-7", message: "Which parks are near a station?", origin: { page: "sql", draft: "SELECT 1;" } });
    expect(after.restored).toBe(true);
    expect(before.restored).toBe(false);
  });
  it("settlement and unavailability clear the tab's state, and only the locator's fields are stored", () => {
    const store = new ConversationStore();
    store.active = { id: "run-8", message: "Rename it", origin: { page: "builder" } };
    expect(JSON.parse(sessionStorage.getItem("dezfil.assistant.active")!)).toEqual({ id: "run-8", message: "Rename it", origin: { page: "builder" } });
    // The run settled: the hook clears the active turn, and the locator with it.
    store.active = null;
    expect(sessionStorage.getItem("dezfil.assistant.active")).toBeNull();
    expect(new ConversationStore().active).toBeNull();
    // Unavailability (a 404 on the recovery read) goes the same way.
    store.active = { id: "run-9", message: "Gone" };
    store.active = null;
    expect(new ConversationStore().restored).toBe(false);
  });
  it("starts empty with no storage at all, as on the server", () => {
    vi.stubGlobal("sessionStorage", undefined);
    const store = new ConversationStore();
    expect(store.active).toBeNull();
    store.active = { id: "run-10", message: "Fine" };
    expect(store.active?.id).toBe("run-10");
  });
});
