import { describe, expect, it } from "vitest";
import { AssistantRunStore } from "./runs";
import { compactReceipt, jsonBytes } from "./recovery-data";

describe("bounded recovery owner", () => {
  it("separates provider messages while replacing each streamed segment exactly once", () => {
    const store = new AssistantRunStore(); const id = store.reserve().id; store.bind(id, {});
    store.record(id, { type: "text_delta", messageId: "a", text: "Ear" });
    store.record(id, { type: "text_delta", messageId: "a", text: "ly" });
    store.record(id, { type: "message", messageId: "a", text: "Early" });
    store.record(id, { type: "text_delta", messageId: "b", text: "Ne" });
    expect(store.read(id).text).toBe("Early\n\nNe");
    store.record(id, { type: "message", messageId: "b", text: "Next" });
    store.record(id, { type: "message", messageId: "c", text: "Last" });
    store.finish(id);
    expect(store.read(id).text).toBe("Early\n\nNext\n\nLast");
  });
  it("expires unused reservations at five minutes, never a live or pending run", () => {
    let clock = 0; const store = new AssistantRunStore(() => clock);
    const reserved = store.reserve().id; const running = store.reserve().id; const parked = store.reserve().id;
    store.bind(running, { message: "Work" }); store.bind(parked, { message: "Pause" });
    store.record(parked, { type: "confirm_required", id: "pending", tool: "delete_map", args: { id: "original" } });
    clock = 299_999; expect(store.read(reserved).state).toBe("reserved");
    clock++; expect(store.read(reserved).state).toBe("unavailable");
    expect(() => store.bind(reserved, { message: "Work" })).toThrow("unavailable");
    clock = 86_400_000;
    expect(store.read(running).state).toBe("running"); expect(store.pending()[0].args).toEqual({ id: "original" });
    expect(store.read(parked).state).toBe("awaiting_confirmation");
  });
  it("retains the newest 256 terminal receipts and never executes an evicted or pre-restart identity", () => {
    const store = new AssistantRunStore();
    const ids: string[] = [];
    for (let i = 0; i < 256; i++) {
      const id = store.reserve().id; ids.push(id); store.bind(id, { message: "Once" }); store.finish(id);
    }
    expect(store.read(ids[0]).state).toBe("completed");
    const next = store.reserve().id; store.bind(next, {}); store.finish(next);
    expect(() => store.read(ids[0])).toThrow("unavailable");
    expect(() => store.bind(ids[0], { message: "Once" })).toThrow("unavailable");
    expect(store.read(ids[1]).state).toBe("completed");
    expect(() => new AssistantRunStore().bind(next, {})).toThrow("unavailable");
  });
  it("terminal receipts fit 64 KiB, preserve identities/outcomes and omit raw result bodies", () => {
    const store = new AssistantRunStore(); const id = store.reserve().id; store.bind(id, {});
    store.record(id, { type: "message", text: "é".repeat(50_000) });
    store.record(id, { type: "tool_call", id: "actual-call", tool: "create_map", args: { name: "x".repeat(80_000) } });
    store.record(id, { type: "tool_result", id: "actual-call", tool: "create_map", ok: true, body: { rows: ["RAW_BODY_MUST_NOT_SURVIVE"] } });
    store.finish(id); const receipt = store.read(id);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(65_536);
    expect(receipt.incomplete).toBe(true);
    // The terminal compaction marks the arguments it dropped.
    expect(receipt.actions).toEqual([{ id: "actual-call", tool: "create_map", status: "succeeded", omitted: true }]);
    expect(JSON.stringify(receipt)).not.toContain("RAW_BODY_MUST_NOT_SURVIVE");
    const exact = { ...receipt, text: "", incomplete: false };
    exact.text = "x".repeat(65_536 - jsonBytes(exact));
    expect(compactReceipt(exact, 65_536, true)).toEqual(exact);
    expect(compactReceipt({ ...exact, text: exact.text + "x" }, 65_536, true).incomplete).toBe(true);
  });
  it("an admitted gate with oversized arguments settles inside the terminal bound", () => {
    // Seeded defect: settling retains the gate's arguments in `confirmations`,
    // which admission never counted and the terminal compaction never trims,
    // so a gate admitted under the live bound throws assistant_recovery_limit
    // when it settles.
    const store = new AssistantRunStore(); const id = store.reserve().id; store.bind(id, {});
    const args = { id: "recipe-1", members: Array.from({ length: 4000 }, (_, i) => `step-${i}-${"m".repeat(12)}`) };
    expect(jsonBytes(args)).toBeGreaterThan(65_536);
    store.admit(id, { id: "gated", name: "run_recipe", args });
    store.record(id, { type: "confirm_required", id: "open", tool: "run_recipe", args });
    store.resume(id, "approved");
    store.finish(id);
    const receipt = store.read(id);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(65_536);
    expect(receipt.confirmations).toEqual([expect.objectContaining({ id: "open", tool: "run_recipe", decision: "approved", omitted: true })]);
    expect(receipt.confirmations![0].args).toBeUndefined();
  });
  it("separately holds the 1 MiB live bound and preserves exact pending arguments", () => {
    const store = new AssistantRunStore(); const id = store.reserve().id; store.bind(id, {});
    const args = { id: "target", detail: "a".repeat(100_000) };
    store.record(id, { type: "confirm_required", id: "open", tool: "delete_map", args });
    store.record(id, { type: "message", text: "é".repeat(600_000) });
    const receipt = store.read(id);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(1_048_576);
    expect(receipt.incomplete).toBe(true); expect(receipt.pending?.args).toEqual(args);
    const remaining = 1_048_576 - jsonBytes({ ...receipt, text: "", incomplete: false });
    const exact = { ...receipt, text: "x".repeat(remaining), incomplete: false };
    expect(compactReceipt(exact, 1_048_576, false)).toEqual(exact);
    expect(compactReceipt({ ...exact, text: exact.text + "x" }, 1_048_576, false).incomplete).toBe(true);
    expect(() => store.admit(id, { id: "too-large", name: "create_map", args: { name: "x".repeat(1_048_576) } })).toThrow("live recovery bound");
  });
});
