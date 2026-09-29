import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { readHold } from "@/lib/test-support/read-hold";
import { createMap } from "@/lib/map-service";
import { assistantRuns, AssistantRunStore } from "@/lib/assistant/runs";
import { PendingActionStore } from "@/lib/assistant/pending";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { runStream } from "@/lib/assistant/run-stream";
import { executionControl } from "@/lib/assistant/execution-control";
import type { ModelProvider } from "@/lib/assistant/provider";
import type { AccountScope } from "./scope";

let db: Database, scopes: Record<string, AccountScope>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scopes = Object.fromEntries(accounts.map(id => [id, testAccountScope(db, id)]));
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run(); assistantRuns.resetForTests();
});
afterEach(() => { assistantRuns.resetForTests(); vi.restoreAllMocks(); db.close(); });
function unavailable(action: () => unknown) { expect(action).toThrow(expect.objectContaining({ code: "assistant_run_unavailable", status: 404 })); }
it("retains each initiator's completed receipt after its output disappears and fences every store operation", () => {
  const store = new AssistantRunStore();
  for (const account of accounts) {
    const scope = scopes[account], map = createMap(scope, `Private ${account}`), run = store.reserve(scope);
    store.bind(scope, run.id, { message: "Create a map" });
    store.record(scope, run.id, { type: "tool_result", id: "made", tool: "create_map", ok: true, body: map, args: { name: map.name }, subject: { id: map.id, resource: "maps", name: map.name } });
    store.record(scope, run.id, { type: "message", text: account }); store.finish(scope, run.id);
    db.prepare("DELETE FROM maps WHERE id = ?").run(map.id);
    const before = store.read(scope, run.id);
    for (const other of accounts.filter(id => id !== account)) for (const id of [run.id, "missing"]) {
      for (const action of [() => store.read(scopes[other], id), () => store.bind(scopes[other], id, {}),
        () => store.release(scopes[other], id), () => store.cancel(scopes[other], id), () => store.resume(scopes[other], id),
        () => store.record(scopes[other], id, { type: "message", text: "wrong" }), () => store.finish(scopes[other], id),
        () => store.fail(scopes[other], id, { code: "wrong", message: "wrong" }), () => store.signal(scopes[other], id),
        () => store.bindChoice(scopes[other], id, { model: "x", effort: "x", defaulted: { model: false, effort: false } }),
        () => store.admit(scopes[other], id, { id: "x", name: "create_map", args: {} }), () => store.checkPark(scopes[other], id, {})]) unavailable(action);
      store.reported(scopes[other], id, "not-recorded");
    }
    expect(store.read(scope, run.id)).toEqual(before); expect(before.text).toBe(account);
    expect(before.actions[0].subject?.id).toBe(map.id);
  }
});
it("keeps parked continuations and their resolved traces private without consuming a hidden action", async () => {
  const store = new PendingActionStore(), scope = scopes.alice;
  const exchange = { send: vi.fn(), continueWith: vi.fn() };
  const id = store.park(scope, { exchange, calls: [{ id: "call", name: "create_map", args: { name: "Private" } }], index: 0, outcomes: [], steps: 1, headers: {}, policy: "full" });
  const original = store.peek(scope, id)!;
  for (const other of [scopes.bob, scopes.admin]) for (const value of [id, "missing"]) {
    expect(store.peek(other, value)).toBeUndefined(); expect(store.claim(other, value, "approved")).toBeUndefined();
    store.supersede(other, value); expect(store.resolutionOf(other, value)).toBeUndefined();
  }
  expect(store.peek(scope, id)).toEqual(original);
  const parked = store.claim(scope, id, "approved")!;
  expect(store.resolutionOf(scope, id)).toBe("approved"); expect(store.resolutionOf(scopes.bob, id)).toBeUndefined();
  const generator = resumeAssistant(parked, true, { scope: scopes.bob, baseUrl: "http://instance.test" });
  await expect(generator.next()).rejects.toMatchObject({ code: "pending_unknown" });
  expect(exchange.send).not.toHaveBeenCalled(); expect(exchange.continueWith).not.toHaveBeenCalled();
});
it.each(["reply", "delta"])("drains deactivation during a provider %s without storing or emitting its late content", async mode => {
  const scope = scopes.alice, run = assistantRuns.reserve(scope); assistantRuns.bind(scope, run.id, {});
  const gate = readHold("provider reply"), dispatch = vi.fn();
  const provider: ModelProvider = { id: "fixture", model: "fixture", exchange: () => ({
    async send(_text, options) {
      await gate.engage();
      if (mode === "delta") options?.onTextDelta?.("late private text");
      return { text: "late private text", toolCalls: [{ id: "late", name: "create_map", args: { name: "Must not happen" } }] };
    }, continueWith: vi.fn(),
  }) };
  const control = executionControl(scope, run.id, new AbortController().signal);
  const response = runStream(scope, runAssistant(provider, { message: "Work", history: [] }, { scope, runId: run.id, baseUrl: "http://instance.test", fetchImpl: dispatch, signal: control.signal }), run.id, control);
  const reading = response.text();
  try {
    await gate.beforeMutation(); db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); gate.release();
    const text = await reading; expect(text).not.toContain("late private text"); expect(text).toContain("authentication_required"); expect(dispatch).not.toHaveBeenCalled();
    expect(() => assistantRuns.read(scope, run.id)).toThrow(expect.objectContaining({ code: "authentication_required" }));
    db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
    expect(assistantRuns.read(scope, run.id)).toMatchObject({ state: "interrupted", text: "", actions: [], error: { code: "authentication_required" } });
    expect(assistantRuns.settleInactive(run.id)).toBe(false);
  } finally { gate.release(); await reading; }
});
it("rejects a late recording after deactivation, preserving already committed action facts", () => {
  const store = new AssistantRunStore(), scope = scopes.alice, run = store.reserve(scope); store.bind(scope, run.id, {});
  const event: AssistantEvent = { type: "tool_result", id: "committed", tool: "create_map", ok: true, body: {}, subject: { resource: "maps", id: "output" } };
  store.record(scope, run.id, event);
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect(() => store.record(scope, run.id, { type: "message", text: "late" })).toThrow(expect.objectContaining({ code: "authentication_required" }));
  expect(store.settleInactive(run.id)).toBe(true);
  db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(store.read(scope, run.id)).toMatchObject({ state: "interrupted", text: "", actions: [{ id: "committed", status: "succeeded", subject: { id: "output" } }] });
});
