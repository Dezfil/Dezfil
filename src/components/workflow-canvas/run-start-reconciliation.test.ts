import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
import { HookHarness } from "./hook-harness";
import { useWorkflowRun } from "./use-workflow-run";
import { useRunConfirm } from "./use-run-confirm";
import type { WorkflowRun } from "./run-overlay";
import { wire } from "./fetch-wire";
const list = "/api/recipes/w/runs", path = `${list}/r`;
const run: WorkflowRun = { id: "r", recipeId: "w", kind: "single", outcome: null, cancelled: false, startedAt: "2026-09-06", finishedAt: null, members: [] };
const harnesses: HookHarness<unknown>[] = [];
async function setup() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const ports = { settle: async () => null, onRecipeChanged: vi.fn(async () => true), onTablesChanged: vi.fn(async () => true), onRunSeen: vi.fn() };
  const h = new HookHarness(() => useWorkflowRun("w", ports)); harnesses.push(h);
  w.pending("GET", list)[0].ok({ runs: [] }); await w.settle();
  return { w, h, ports };
}
const observe = <T,>(p: Promise<T>) => { const result: { value: T | "pending" | "rejected" } = { value: "pending" }; void p.then((v) => { result.value = v; }, () => { result.value = "rejected"; }); return result; };
afterEach(() => { for (const h of harnesses.splice(0)) h.unmount(); vi.unstubAllGlobals(); });

describe.each(["node", "all"])("%s run start", (mode) => {
  const startPath = mode === "node" ? "/api/recipes/w/steps/a/run" : list;
  const start = (c: Awaited<ReturnType<typeof setup>>) => observe(mode === "node" ? c.h.value.runNode("a") : c.h.value.start({}));
  it.each(["truncated", "bodyFailure"] as const)("%s success reconciles one list read and adopts exactly one observer", async (body) => {
    const c = await setup(); const result = start(c); await c.w.settle(); c.w.pending("POST", startPath)[0][body](); await c.w.settle();
    expect(c.w.pending("GET", list)).toHaveLength(1);
    c.w.pending("GET", list)[0].ok({ runs: [run] }); await c.w.settle();
    expect(result.value).toEqual({ kind: "started", run }); expect(c.h.value.state.phase).toBe("running"); expect(c.ports.onRunSeen).toHaveBeenCalledOnce();
    expect(c.w.pending("GET", path)).toHaveLength(1); expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(1);
    expect(c.w.calls.filter((x) => x.path === list && x.method === "GET")).toHaveLength(2); // initial load + exactly one reconciliation
  });
  it.each(["empty", "terminal only", "cut", "broken body"])("unconfirmed start with %s read settles with precise copy", async (answer) => {
    const c = await setup(); const result = start(c); await c.w.settle(); c.w.pending("POST", startPath)[0].truncated(); await c.w.settle(); expect(c.w.pending("GET", list)).toHaveLength(1);
    const read = c.w.pending("GET", list)[0];
    if (answer === "cut") read.cut(); else if (answer === "broken body") read.bodyFailure(); else read.ok({ runs: answer === "empty" ? [] : [{ ...run, outcome: "completed" }] });
    await c.w.settle();
    expect(result.value).toMatchObject({ kind: "refused", message: "Couldn't confirm the run started." }); expect(c.h.value.state.phase).toBe("idle"); expect(c.ports.onRunSeen).not.toHaveBeenCalled();
    expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(1); expect(c.w.pending("GET", path)).toHaveLength(0);
  });
  it.each(["cut", "4xx", "5xx", "clean"])("%s control settles the start", async (answer) => {
    const c = await setup(); const result = start(c); await c.w.settle(); const request = c.w.pending("POST", startPath)[0];
    if (answer === "cut") request.cut(); else if (answer === "clean") request.ok({ run }); else request.refuse(answer === "4xx" ? 409 : 500, "cannot_start", "Cannot start");
    await c.w.settle();
    expect(result.value).toMatchObject({ kind: answer === "clean" ? "started" : "refused" }); expect(c.h.value.state.phase).toBe(answer === "clean" ? "running" : "idle");
    expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});

it("the Run all action notice carries the unconfirmed-start sentence", async () => {
  const c = await setup(); const flow = new HookHarness(() => useRunConfirm({ runner: c.h.value }));
  const request = observe(flow.value.askRun(null)); await c.w.settle(); c.w.pending("POST", list)[0].ok({ plan: { wide: false, kind: "run_all", members: ["a"] } }); await c.w.settle();
  c.w.pending("POST", list)[0].truncated(); await c.w.settle(); expect(c.w.pending("GET", list)).toHaveLength(1); c.w.pending("GET", list)[0].ok({ runs: [] }); await c.w.settle(); flow.render();
  expect(request.value).toBeUndefined(); expect(flow.value.refusal?.message).toBe("Couldn't confirm the run started.");
});

it.each(["node", "all"])("found on the way: late %s start response cannot revive an unmounted observer", async (mode) => {
  const c = await setup();
  const outcome = observe(mode === "node" ? c.h.value.runNode("a") : c.h.value.start({})); await c.w.settle();
  c.h.unmount(); const state = c.h.value.state; const count = c.w.calls.length;
  c.w.calls.find((x) => !x.answered)!.truncated(); await c.w.settle();
  expect(c.w.calls).toHaveLength(count); expect(c.h.value.state).toBe(state); expect(c.ports.onRunSeen).not.toHaveBeenCalled();
  expect(outcome.value).toMatchObject({ kind: "refused" });
});

it("found on the way: a start waiting for the barrier cannot send after cleanup and remount", async () => {
  const c = await setup(); let release!: () => void;
  c.h.value.setFlush(() => new Promise((resolve) => { release = () => resolve(null); }));
  const outcome = observe(c.h.value.start({})); c.h.unmount(); c.h.remount();
  c.w.pending("GET", list)[0].ok({ runs: [] }); await c.w.settle();
  release(); await c.w.settle();
  expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(0); expect(outcome.value).toMatchObject({ kind: "refused" });
});
