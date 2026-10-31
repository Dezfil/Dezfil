import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, expect, it } from "vitest";
import { AssistantRunStore } from "./runs";
import { compactReceipt, jsonBytes } from "./recovery-data";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

describe("bounded recovery owner", () => {
  it("separates provider messages while replacing each streamed segment exactly once", () => {
    const store = new AssistantRunStore(); const id = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), id, {});
    store.record(testAccountScope(), id, { type: "text_delta", messageId: "a", text: "Ear" });
    store.record(testAccountScope(), id, { type: "text_delta", messageId: "a", text: "ly" });
    store.record(testAccountScope(), id, { type: "message", messageId: "a", text: "Early" });
    store.record(testAccountScope(), id, { type: "text_delta", messageId: "b", text: "Ne" });
    expect(store.read(testAccountScope(), id).text).toBe("Early\n\nNe");
    store.record(testAccountScope(), id, { type: "message", messageId: "b", text: "Next" });
    store.record(testAccountScope(), id, { type: "message", messageId: "c", text: "Last" });
    store.finish(testAccountScope(), id);
    expect(store.read(testAccountScope(), id).text).toBe("Early\n\nNext\n\nLast");
  });
  it("expires unused reservations at five minutes, never a live or pending run", () => {
    let clock = 0; const store = new AssistantRunStore(() => clock);
    const running = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), running, { message: "Work" });
    const parked = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), parked, { message: "Pause" });
    const reserved = store.reserve(testAccountScope()).id;
    store.record(testAccountScope(), parked, { type: "confirm_required", id: "pending", tool: "delete_map", args: { id: "original" } });
    clock = 299_999; expect(store.read(testAccountScope(), reserved).state).toBe("reserved");
    clock++; expect(store.read(testAccountScope(), reserved).state).toBe("unavailable");
    expect(() => store.bind(testAccountScope(), reserved, { message: "Work" })).toThrow("unavailable");
    clock = 86_400_000;
    expect(store.read(testAccountScope(), running).state).toBe("running"); expect(store.pending(testAccountScope())[0].args).toEqual({ id: "original" });
    expect(store.read(testAccountScope(), parked).state).toBe("awaiting_confirmation");
  });
  it("takes a place at binding, keeps it through a wait for confirmation, and needs none to resume", () => {
    const store = new AssistantRunStore();
    const held: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), id, { message: `Work ${i}` }); held.push(id);
      store.record(testAccountScope(), id, { type: "confirm_required", id: `pending-${i}`, tool: "delete_map", args: {} });
    }
    const fifth = store.reserve(testAccountScope()).id;
    expect(() => store.bind(testAccountScope(), fifth, { message: "Fifth" })).toThrow(/four/);
    store.resume(testAccountScope(), held[0], "approved");
    expect(store.read(testAccountScope(), held[0]).state).toBe("running");
    expect(() => store.bind(testAccountScope(), fifth, { message: "Fifth" })).toThrow(/four/);
    store.finish(testAccountScope(), held[0]);
    expect(store.bind(testAccountScope(), fifth, { message: "Fifth" })).toBe(true);
  });
  it("lets an expired reservation free its account's count", () => {
    let clock = 0; const store = new AssistantRunStore(() => clock);
    store.reserve(testAccountScope()); store.reserve(testAccountScope());
    expect(() => store.reserve(testAccountScope())).toThrow(ERROR_CATALOGUE.assistant_reservation_limit);
    clock = 300_000;
    expect(store.reserve(testAccountScope()).state).toBe("reserved");
  });
  it("retains the newest 256 terminal receipts and never executes an evicted or pre-restart identity", () => {
    const store = new AssistantRunStore();
    const ids: string[] = [];
    for (let i = 0; i < 256; i++) {
      const id = store.reserve(testAccountScope()).id; ids.push(id); store.bind(testAccountScope(), id, { message: "Once" }); store.finish(testAccountScope(), id);
    }
    expect(store.read(testAccountScope(), ids[0]).state).toBe("completed");
    const next = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), next, {}); store.finish(testAccountScope(), next);
    expect(() => store.read(testAccountScope(), ids[0])).toThrow("unavailable");
    expect(() => store.bind(testAccountScope(), ids[0], { message: "Once" })).toThrow("unavailable");
    expect(store.read(testAccountScope(), ids[1]).state).toBe("completed");
    expect(() => new AssistantRunStore().bind(testAccountScope(), next, {})).toThrow("unavailable");
  });
  it("terminal receipts fit 64 KiB, preserve identities/outcomes and omit raw result bodies", () => {
    const store = new AssistantRunStore(); const id = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), id, {});
    store.record(testAccountScope(), id, { type: "message", text: "é".repeat(50_000) });
    store.record(testAccountScope(), id, { type: "tool_call", id: "actual-call", tool: "create_map", args: { name: "x".repeat(80_000) } });
    store.record(testAccountScope(), id, { type: "tool_result", id: "actual-call", tool: "create_map", ok: true, body: { rows: ["RAW_BODY_MUST_NOT_SURVIVE"] } });
    store.finish(testAccountScope(), id); const receipt = store.read(testAccountScope(), id);
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
    const store = new AssistantRunStore(); const id = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), id, {});
    const args = { id: "recipe-1", members: Array.from({ length: 4000 }, (_, i) => `step-${i}-${"m".repeat(12)}`) };
    expect(jsonBytes(args)).toBeGreaterThan(65_536);
    store.admit(testAccountScope(), id, { id: "gated", name: "run_recipe", args });
    store.record(testAccountScope(), id, { type: "confirm_required", id: "open", tool: "run_recipe", args });
    store.resume(testAccountScope(), id, "approved");
    store.finish(testAccountScope(), id);
    const receipt = store.read(testAccountScope(), id);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(65_536);
    expect(receipt.confirmations).toEqual([expect.objectContaining({ id: "open", tool: "run_recipe", decision: "approved", omitted: true })]);
    expect(receipt.confirmations![0].args).toBeUndefined();
  });
  it("separately holds the 1 MiB live bound and preserves exact pending arguments", () => {
    const store = new AssistantRunStore(); const id = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), id, {});
    const args = { id: "target", detail: "a".repeat(100_000) };
    store.record(testAccountScope(), id, { type: "confirm_required", id: "open", tool: "delete_map", args });
    store.record(testAccountScope(), id, { type: "message", text: "é".repeat(600_000) });
    const receipt = store.read(testAccountScope(), id);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(1_048_576);
    expect(receipt.incomplete).toBe(true); expect(receipt.pending?.args).toEqual(args);
    const remaining = 1_048_576 - jsonBytes({ ...receipt, text: "", incomplete: false });
    const exact = { ...receipt, text: "x".repeat(remaining), incomplete: false };
    expect(compactReceipt(exact, 1_048_576, false)).toEqual(exact);
    expect(compactReceipt({ ...exact, text: exact.text + "x" }, 1_048_576, false).incomplete).toBe(true);
    expect(() => store.admit(testAccountScope(), id, { id: "too-large", name: "create_map", args: { name: "x".repeat(1_048_576) } })).toThrow("live recovery bound");
  });
});
