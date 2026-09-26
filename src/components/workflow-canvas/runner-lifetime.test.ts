import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
import { HookHarness } from "./hook-harness";
import { useWorkflowRun } from "./use-workflow-run";
import type { WorkflowRun } from "./run-overlay";
import { wire } from "./fetch-wire";
const list = "/api/recipes/w/runs", path = `${list}/r`;
const run: WorkflowRun = { id: "r", recipeId: "w", kind: "single", outcome: null, cancelled: false, startedAt: "2026-09-06", finishedAt: null, members: [] };
const harnesses: HookHarness<unknown>[] = [];
function setup() {
  vi.useFakeTimers(); const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const ports = { settle: async () => null, onRecipeChanged: vi.fn(async () => true), onTablesChanged: vi.fn(async () => true), onRunSeen: vi.fn() };
  const h = new HookHarness(() => useWorkflowRun("w", ports)); harnesses.push(h);
  const observation = () => ({ state: h.value.state, updates: h.updates, recipe: ports.onRecipeChanged.mock.calls.length, tables: ports.onTablesChanged.mock.calls.length, seen: ports.onRunSeen.mock.calls.length });
  return { w, h, ports, observation };
}
afterEach(() => { for (const h of harnesses.splice(0)) h.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("observation lifetime", () => {
  it("unmount releases a waiting poll and emits no later request, status or refresh", async () => {
    const c = setup(); c.w.pending("GET", list)[0].ok({ runs: [run] }); await setImmediate(); c.w.pending("GET", path)[0].ok({ run }); await setImmediate();
    expect(vi.getTimerCount()).toBe(1);
    c.h.unmount(); const before = c.observation(); const calls = c.w.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.w.calls).toHaveLength(calls); expect(c.observation()).toEqual(before);
    expect(c.w.calls.filter((x) => x.path.endsWith("/cancel"))).toHaveLength(0); // control
  });

  it("mounted control continues polling", async () => {
    const c = setup(); c.w.pending("GET", list)[0].ok({ runs: [run] }); await setImmediate(); c.w.pending("GET", path)[0].ok({ run }); await setImmediate();
    await vi.advanceTimersByTimeAsync(1000); expect(c.w.pending("GET", path)).toHaveLength(1);
  });

  it.each(["initial success", "initial failure", "active success", "active failure"])("late %s after cleanup cannot observe, notify or refresh", async (seed) => {
    const c = setup();
    if (seed.startsWith("active")) { c.w.pending("GET", list)[0].ok({ runs: [run] }); await setImmediate(); }
    const pending = c.w.calls.find((x) => !x.answered)!;
    c.h.unmount(); const before = c.observation(); const count = c.w.calls.length;
    if (seed.endsWith("failure")) pending.cut(); else pending.ok(seed.startsWith("initial") ? { runs: [run] } : { run: { ...run, outcome: "completed" } });
    await setImmediate(); await vi.advanceTimersByTimeAsync(4000);
    expect(c.observation()).toEqual(before); expect(c.w.calls).toHaveLength(count);
    expect(c.w.calls.filter((x) => x.path.endsWith("/cancel"))).toHaveLength(0); // control
  });

  it.each(["same memoized runner", "new screen"])("remount with %s follows the durable run with exactly one observer", async (mode) => {
    const c = setup(); c.w.pending("GET", list)[0].ok({ runs: [run] }); await setImmediate(); c.w.pending("GET", path)[0].ok({ run }); await setImmediate();
    c.h.unmount();
    if (mode === "same memoized runner") c.h.remount();
    else { const h = new HookHarness(() => useWorkflowRun("w", c.ports)); harnesses.push(h); }
    c.w.pending("GET", list)[0].ok({ runs: [run] }); await setImmediate();
    expect(c.w.pending("GET", path)).toHaveLength(1); c.w.pending("GET", path)[0].ok({ run }); await setImmediate();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000); expect(c.w.pending("GET", path)).toHaveLength(1);
      c.w.pending("GET", path)[0].ok({ run }); await setImmediate(); expect(vi.getTimerCount()).toBe(1);
    }
    expect(c.w.calls.filter((x) => x.path.endsWith("/cancel"))).toHaveLength(0); // control
  });

  it("quick setup cleanup setup ignores the first late list and keeps one observer", async () => {
    const c = setup(); const old = c.w.pending("GET", list)[0]; c.h.unmount(); c.h.remount();
    c.w.pending("GET", list)[1].ok({ runs: [run] }); await setImmediate(); old.ok({ runs: [run] }); await setImmediate();
    expect(c.w.pending("GET", path)).toHaveLength(1); expect(c.ports.onRunSeen).toHaveBeenCalledOnce();
    c.w.pending("GET", path)[0].ok({ run }); await setImmediate(); await vi.advanceTimersByTimeAsync(1000); expect(c.w.pending("GET", path)).toHaveLength(1);
  });
});
