import { describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store";

/** The tab's one conversation: a store the panes on
 * three pages read, with the external-store contract React subscribes
 * to. Retention across navigation is browser evidence;
 * the store's own contract is held here. */
describe("the conversation store", () => {
  it("starts empty, patches by value or by function, and notifies subscribers once per set", () => {
    const store = new ConversationStore();
    expect(store.get().turns).toEqual([]);
    let notified = 0;
    const off = store.subscribe(() => { notified += 1; });
    store.set({ input: "draft" });
    store.set((s) => ({ turns: [...s.turns, { role: "user", text: "Hello", runId: "r1" }] }));
    expect(store.get().input).toBe("draft");
    expect(store.get().turns).toHaveLength(1);
    expect(notified).toBe(2);
    off();
    store.set({ input: "" });
    expect(notified).toBe(2);
  });
  it("returns the same snapshot between sets, as useSyncExternalStore requires", () => {
    const store = new ConversationStore();
    const a = store.get();
    expect(store.get()).toBe(a);
    store.set({ busy: true });
    expect(store.get()).not.toBe(a);
  });
  it("keeps the in-flight bookkeeping outside the rendered state and resets it for tests", () => {
    const store = new ConversationStore();
    store.active = { id: "run", message: "Hi" };
    store.locked = true;
    store.resetForTests();
    expect(store.active).toBeNull();
    expect(store.locked).toBe(false);
    expect(store.get().turns).toEqual([]);
  });
});
