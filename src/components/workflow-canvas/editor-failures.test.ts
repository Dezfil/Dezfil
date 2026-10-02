import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
vi.mock("./edits-context", () => ({ useEdits: () => context.edits }));
vi.mock("./run-context", () => ({ useRunner: () => context.runner }));
const context = vi.hoisted(() => ({ edits: null as unknown, runner: null as unknown }));
import { HookHarness } from "./hook-harness";
import { RecipeEditor } from "./use-recipe-edits";
import { useWorkflowRun } from "./use-workflow-run";
import { usePanelDraft } from "./use-panel-draft";
import { useRunConfirm } from "./use-run-confirm";
import { savedWhisper } from "./save-whisper";
import { wire } from "./fetch-wire";
import type { SaveState } from "./use-layout-saves";
import type { WorkflowStep } from "../workflow-model";
import { findOperation } from "@/lib/operations/catalog";

export const stepOf = (id: string, parameters: Record<string, unknown>): WorkflowStep => ({ id, parameters, proposedParameters: null, ordinal: 0, operation: "buffer", output: null, condition: "ready", conditions: ["ready"], causes: [], missingInputs: [], inputs: [], reads: [], latestAttempt: null, lastSuccessAt: null });
const cleanups: (() => void)[] = [];
function setup() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, activeElement: null });
  const states: SaveState[] = [];
  const editor = new RecipeEditor("w", { onState: (s) => states.push(s), onAccepted() {} }, { lockReason: () => null, say() {} });
  const h = new HookHarness(() => useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }));
  cleanups.push(() => h.unmount());
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] });
  context.edits = editor; context.runner = h.value;
  return { w, editor, runner: h.value, states };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
const patch = "/api/recipes/w/steps/a";
const structural = [
  { name: "add", method: "POST", path: "/api/recipes/w/steps", start: (e: RecipeEditor) => e.add({ operation: "buffer", parameters: { name: "taken" } }) },
  { name: "discard", method: "DELETE", path: `${patch}/proposal`, start: (e: RecipeEditor) => e.discard("a") },
  { name: "move", method: "POST", path: `${patch}/move`, start: (e: RecipeEditor) => e.reorder("a", 1) },
  { name: "remove", method: "DELETE", path: patch, start: (e: RecipeEditor) => e.remove("a") },
];

describe("review: structural rejections belong to the settle window", () => {
  it.each(structural)("completed refused $name leaves both Run actions available", async (operation) => {
    for (const mode of ["node", "all"]) {
      const c = setup(); await c.w.settle();
      const mutation = operation.start(c.editor); await c.w.settle();
      c.w.pending(operation.method, operation.path)[0].refuse(409, "conflict", "Change refused");
      expect(await mutation).toMatchObject({ kind: "refused" });
      expect.soft(await c.editor.settled()).toBeNull();
      const running = mode === "node" ? c.runner.runNode("a") : c.runner.start({});
      await c.w.settle();
      const starts = c.w.pending("POST", mode === "node" ? `${patch}/run` : "/api/recipes/w/runs");
      expect.soft(starts).toHaveLength(1);
      starts[0]?.ok({ run: { id: "r", recipeId: "w", kind: mode === "node" ? "single" : "run_all", outcome: null, cancelled: false, startedAt: "2026-09-06", finishedAt: null, members: [] } });
      expect(await running).toMatchObject({ kind: "started" });
    }
  });

  it("completed failed add leaves settle clear and still offers its whisper Retry", async () => {
    const c = setup(); await c.w.settle();
    const input = { operation: "buffer", parameters: { name: "new_node" } };
    const mutation = c.editor.add(input); c.w.pending("POST", "/api/recipes/w/steps")[0].cut();
    expect(await mutation).toMatchObject({ kind: "failed" });
    expect.soft(await c.editor.settled()).toBeNull();
    const state = c.states.at(-1)!;
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("No add Retry");
    state.retry();
    const retry = c.w.pending("POST", "/api/recipes/w/steps")[0];
    expect(retry.body).toEqual(input);
    retry.ok({ step: stepOf("new", input.parameters) }); await c.w.settle();
    expect(c.states.at(-1)?.kind).toBe("saved");
  });

  it("a failed add offers its own Retry over a failed parameter edit, then restores that failure", async () => {
    const c = setup(); await c.w.settle();
    const edit = c.editor.edit("a", { distance: 99 });
    c.w.pending("PATCH", patch)[0].cut(); await edit;
    const earlier = c.states.at(-1)!;
    expect(earlier.kind).toBe("failed");
    const input = { operation: "buffer", parameters: { name: "new_node" } };
    const add = c.editor.add(input);
    c.w.pending("POST", "/api/recipes/w/steps")[0].cut(); await add;
    const newest = c.states.at(-1)!;
    if (newest.kind !== "failed") throw new Error("No structural Retry");
    newest.retry();
    const retries = c.w.pending("POST", "/api/recipes/w/steps");
    expect(retries).toHaveLength(1);
    expect(c.w.pending("PATCH", patch)).toHaveLength(0);
    expect(retries[0].body).toEqual(input);
    retries[0].ok({ step: stepOf("new", input.parameters) }); await c.w.settle();
    expect(c.states.at(-1)).toBe(earlier);
    if (earlier.kind !== "failed") throw new Error("No parameter Retry");
    earlier.retry();
    expect(c.w.pending("PATCH", patch)[0].body).toEqual({ parameters: { distance: 99 } });
    c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 99 }), applied: "active" }); await c.w.settle();
    expect(await c.editor.settled()).toBeNull();
  });

  it.each(structural)("$name rejected during settle blocks that window only", async (operation) => {
    const c = setup(); await c.w.settle();
    const mutation = operation.start(c.editor); await c.w.settle();
    const waiting = c.editor.settled();
    c.w.pending(operation.method, operation.path)[0].refuse(409, "conflict", "Change refused");
    await mutation;
    expect(await waiting).toMatchObject({ kind: "refused", message: "Change refused" });
    expect(await c.editor.settled()).toBeNull();
  });

  it.each(["draft", "structure"])("settle reports the newest rejection when %s lands last", async (last) => {
    const c = setup(); await c.w.settle();
    const first = last === "draft" ? structural[0].start(c.editor) : c.editor.edit("a", { distance: 99 });
    const second = last === "draft" ? c.editor.edit("a", { distance: 99 }) : structural[0].start(c.editor);
    const draft = last === "draft" ? second : first;
    const add = last === "draft" ? first : second;
    const waiting = c.editor.settled();
    const rejectDraft = async () => { c.w.pending("PATCH", patch)[0].refuse(422, "invalid", "Draft refused"); await draft; };
    const rejectAdd = async () => { c.w.pending("POST", "/api/recipes/w/steps")[0].refuse(409, "conflict", "Add refused"); await add; };
    if (last === "draft") { await rejectAdd(); await rejectDraft(); }
    else { await rejectDraft(); await rejectAdd(); }
    expect(await waiting).toMatchObject({ message: last === "draft" ? "Draft refused" : "Add refused" });
    expect(await c.editor.settled()).toMatchObject({ message: "Draft refused" });
  });

  it("overlapping settle calls retain their own structural window", async () => {
    const c = setup(); await c.w.settle();
    const add = structural[0].start(c.editor);
    const save = c.editor.edit("a", { distance: 20 });
    const first = c.editor.settled();
    c.w.pending("POST", "/api/recipes/w/steps")[0].refuse(409, "conflict", "Add refused"); await add;
    const second = c.editor.settled();
    c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 20 }), applied: "active" }); await save;
    expect(await first).toMatchObject({ message: "Add refused" });
    expect(await second).toBeNull();
  });
});

async function blocked(c: ReturnType<typeof setup>) {
  // Give a leaked start an immediate refusal, so a regression fails on its
  // actual outcome/request count instead of timing out on our manual wire.
  const fetch = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(path).endsWith("/runs") && init.body && JSON.parse(String(init.body)).plan)
      return new Response(JSON.stringify({ plan: { wide: false, members: ["a"], kind: "run_all" } }));
    return new Response(JSON.stringify({ error: { code: "unexpected_start", message: "Unexpected start" } }), { status: 409 });
  });
  vi.stubGlobal("fetch", fetch);
  for (let i = 0; i < 2; i++) {
    expect(await c.runner.runNode("a")).toMatchObject({ kind: "save_failed" });
    expect(await c.runner.start({})).toMatchObject({ kind: "save_failed" });
  }
  const confirm = new HookHarness(() => useRunConfirm({ runner: c.runner }));
  await confirm.value.askRun(null); confirm.render();
  expect(confirm.value.refusal?.message).toMatch(/^Couldn't save the change, so nothing started\. /);
  expect(fetch.mock.calls.filter(([path, init]) => init?.method === "POST" && !(String(path).endsWith("/runs") && init.body && JSON.parse(String(init.body)).plan))).toHaveLength(0);
  vi.stubGlobal("fetch", c.w.fetch);
}

describe("owned failures", () => {
  it.each(["failed", "refused"])("completed %s stays blocked across unrelated save, repeated Run and panel reopen", async (kind) => {
    const c = setup(); await c.w.settle();
    const props = { step: stepOf("a", { distance: 10 }), operation: null, effective: { distance: 10 } };
    let panel = new HookHarness(() => usePanelDraft(props));
    panel.value.set("distance", 99, true); panel.render();
    const flushing = c.runner.flushPanel();
    if (kind === "failed") c.w.pending("PATCH", patch)[0].cut(); else c.w.pending("PATCH", patch)[0].refuse(422, "invalid", "Distance refused");
    await flushing; panel.render();
    await blocked(c);
    const other = c.editor.edit("b", { distance: 20 }); c.w.pending("PATCH", "/api/recipes/w/steps/b")[0].ok({ step: stepOf("b", { distance: 20 }), applied: "active" }); await other;
    await blocked(c);
    panel.unmount(); panel = new HookHarness(() => usePanelDraft(props)); cleanups.push(() => panel.unmount());
    expect(panel.value.values.distance).toBe(99);
    if (kind === "refused") expect(panel.value.refusals.distance).toBe("Distance refused");
    else expect(c.states.at(-1)?.kind).toBe("failed");
    await blocked(c);
    panel.value.set("distance", 30, true); panel.render();
    if (kind === "refused") expect(panel.value.refusals.distance).toBe("Distance refused");
    const correction = c.runner.flushPanel(); panel.render();
    if (kind === "refused") expect(panel.value.refusals.distance).toBe("Distance refused");
    c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 30 }), applied: "active" }); await correction; panel.render();
    expect(panel.value.refusals).toEqual({});
    expect(await c.editor.settled()).toBeNull();
  });

  it("remount reseed preserves a failed draft even when the accepted definition refreshes", async () => {
    const c = setup(); await c.w.settle();
    let effective = { distance: 10 };
    const panel = new HookHarness(() => usePanelDraft({ step: stepOf("a", effective), operation: null, effective })); cleanups.push(() => panel.unmount());
    panel.value.set("distance", 99, true); panel.render(); const flushed = c.runner.flushPanel(); c.w.pending("PATCH", patch)[0].cut(); await flushed; panel.render();
    effective = { distance: 11 }; panel.render();
    expect(panel.value.values.distance).toBe(99);
  });

  it("two failed nodes show newest Retry and restore the other's when it resolves", async () => {
    const c = setup();
    const a = c.editor.edit("a", { distance: 99 }); c.w.pending("PATCH", patch)[0].cut(); await a;
    const first = c.states.at(-1)!;
    const b = c.editor.edit("b", { distance: 88 }); c.w.pending("PATCH", "/api/recipes/w/steps/b")[0].cut(); await b;
    const newest = c.states.at(-1)!; expect(newest).not.toBe(first);
    if (newest.kind !== "failed") throw new Error("No Retry"); newest.retry();
    c.w.pending("PATCH", "/api/recipes/w/steps/b")[0].ok({ step: stepOf("b", { distance: 88 }), applied: "active" }); await c.w.settle();
    expect(c.states.at(-1)).toEqual(first);
    if (first.kind !== "failed") throw new Error("No Retry"); first.retry();
    expect(c.w.pending("PATCH", patch)[0].body).toEqual({ parameters: { distance: 99 } });
    c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 99 }), applied: "active" }); await c.w.settle();
    expect(await c.editor.settled()).toBeNull();
  });

  it.each(["same-owner Saved", "undo recovered"])("%s preserves the coordinator's outstanding Retry", (emitter) => {
    const retry = vi.fn(); const failed: SaveState = { kind: "failed", message: "offline", retry };
    const notice = { owner: "recipe" as const, text: "Couldn’t save", tone: "bad" as const, action: { label: "Retry", run: retry } };
    // Undo's read failure holds its own Retry before its recovered emitter.
    const current = emitter === "undo recovered" ? { ...notice, action: { label: "Retry", run: vi.fn() } } : notice;
    expect(savedWhisper(current, "recipe", failed)).toEqual(notice);
  });

  it.each(["node", "all"])("%s Run waiting for a save fails closed; accepted pending control settles", async (mode) => {
    const c = setup(); await c.w.settle();
    const save = c.editor.edit("a", { distance: 99 });
    const run = mode === "node" ? c.runner.runNode("a") : c.runner.start({});
    c.w.pending("PATCH", patch)[0].cut(); await save;
    expect(await run).toMatchObject({ kind: "save_failed" });
    expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(0);
    const correction = c.editor.edit("a", { distance: 50 });
    const waiting = c.editor.settled(); c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 50 }), applied: "active" }); await correction;
    expect(await waiting).toBeNull();
  });

  it("failed discard preserves the block; successful discard and accepted inverse clear it", async () => {
    const c = setup(); await c.w.settle();
    const save = c.editor.edit("a", { distance: 99 }); c.w.pending("PATCH", patch)[0].cut(); await save;
    const bad = c.editor.discard("a"); await c.w.settle(); c.w.pending("DELETE", `${patch}/proposal`)[0].cut(); await bad;
    expect(await c.editor.settled()).toMatchObject({ kind: "failed" });
    const good = c.editor.discard("a"); await c.w.settle(); c.w.pending("DELETE", `${patch}/proposal`)[0].ok({ step: stepOf("a", { distance: 10 }) }); await good;
    expect(await c.editor.settled()).toBeNull();
    const again = c.editor.edit("a", { distance: 99 }); c.w.pending("PATCH", patch)[0].cut(); await again;
    const inverse = c.editor.owned(() => {}).edit("a", { distance: 10 }); c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 10 }), applied: "active" }); await inverse;
    expect(await c.editor.settled()).toBeNull();
  });
});

it("found on the way: a locally invalid draft survives close and still blocks Run", async () => {
  const c = setup(); await c.w.settle();
  const props = { step: stepOf("a", { distance: 10 }), operation: null, effective: { distance: 10 } };
  let panel = new HookHarness(() => usePanelDraft(props));
  panel.value.set("distance", -1, false); panel.render(); panel.value.setInvalid("Fix distance first.");
  panel.unmount(); expect(await c.editor.settled()).toMatchObject({ kind: "refused", message: "Fix distance first." });
  panel = new HookHarness(() => usePanelDraft(props)); cleanups.push(() => panel.unmount());
  expect(panel.value.values.distance).toBe(-1); await blocked(c);
  panel.value.set("distance", 20, true); panel.render(); panel.value.setInvalid(null);
  const flush = c.runner.flushPanel(); c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 20 }), applied: "active" }); await flush;
  expect(await c.editor.settled()).toBeNull();
});

it("found on the way: an older accepted send cannot resolve a newer locally invalid draft", async () => {
  const c = setup(); await c.w.settle();
  const panel = new HookHarness(() => usePanelDraft({ step: stepOf("a", { distance: 10 }), operation: null, effective: { distance: 10 } })); cleanups.push(() => panel.unmount());
  panel.value.set("distance", 20, true); panel.render(); const flush = c.runner.flushPanel();
  panel.value.set("distance", -1, false); panel.render(); panel.value.setInvalid("Fix distance first.");
  c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 20 }), applied: "active" }); await flush; panel.render();
  expect(await c.editor.settled()).toMatchObject({ kind: "refused" }); expect(panel.value.values.distance).toBe(-1);
});

it("found on the way: accepted inverse clears the field refusal and restores the displayed definition", async () => {
  const c = setup(); await c.w.settle();
  const props = { step: stepOf("a", { distance: 10 }), operation: null, effective: { distance: 10 } };
  const panel = new HookHarness(() => usePanelDraft(props)); cleanups.push(() => panel.unmount());
  panel.value.set("distance", 99, true); panel.render(); const flush = c.runner.flushPanel(); c.w.pending("PATCH", patch)[0].refuse(422, "invalid", "Distance refused"); await flush; panel.render();
  expect(panel.value.refusals.distance).toBe("Distance refused");
  const inverse = c.editor.owned(() => {}).edit("a", { distance: 10 }); panel.render();
  expect(panel.value.values.distance).toBe(99);
  expect(panel.value.refusals.distance).toBe("Distance refused");
  c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 10 }), applied: "active" }); await inverse; panel.render();
  expect(panel.value.refusals).toEqual({}); expect(panel.value.values.distance).toBe(10); expect(await c.editor.settled()).toBeNull();
});

it("review: a clean open panel waits for accepted data during an external edit", async () => {
  const c = setup(); await c.w.settle();
  let effective = { distance: 10 };
  const panel = new HookHarness(() => usePanelDraft({ step: stepOf("a", effective), operation: null, effective })); cleanups.push(() => panel.unmount());
  const inverse = c.editor.owned(() => {}).edit("a", { distance: 20 }); panel.render();
  expect(panel.value.values.distance).toBe(10);
  c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 20 }), applied: "active" }); await inverse; panel.render();
  expect(panel.value.values.distance).toBe(10);
  effective = { distance: 20 }; panel.render();
  expect(panel.value.values.distance).toBe(20);
});

it("review: an API refusal survives a local invalid hold and panel reopen until correction", async () => {
  const c = setup(); await c.w.settle();
  const props = { step: stepOf("a", { distance: 10 }), operation: null, effective: { distance: 10 } };
  let panel = new HookHarness(() => usePanelDraft(props));
  panel.value.set("distance", 99, true); panel.render();
  const flush = c.runner.flushPanel(); c.w.pending("PATCH", patch)[0].refuse(422, "invalid", "Distance refused"); await flush; panel.render();
  panel.value.set("distance", -1, false); panel.render(); panel.value.setInvalid("Fix distance first."); panel.render();
  expect(panel.value.refusals.distance).toBe("Distance refused");
  panel.unmount(); panel = new HookHarness(() => usePanelDraft(props)); cleanups.push(() => panel.unmount());
  expect(panel.value.refusals.distance).toBe("Distance refused");
  expect(panel.value.values.distance).toBe(-1);
  panel.value.set("distance", 20, true); panel.render(); panel.value.setInvalid(null);
  const correction = c.runner.flushPanel(); c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 20 }), applied: "active" }); await correction; panel.render();
  expect(panel.value.refusals).toEqual({});
});

it.each(["refused", "failed"])("a %s name save retains typed and inactive values across panel reopen", async (kind) => {
  const c = setup(); await c.w.settle();
  const effective = { name: "original", relation: "intersects", distance: 125 };
  const props = { step: stepOf("a", effective), operation: findOperation("filter_by_location"), effective };
  let panel = new HookHarness(() => usePanelDraft(props));
  cleanups.push(() => panel.unmount());
  panel.value.set("name", "My", true); panel.render();
  panel.value.set("name", "My Output", true); panel.render();
  const flush = c.runner.flushPanel();
  const request = c.w.pending("PATCH", patch)[0];
  expect(request.body).toEqual({ parameters: { name: "my_output", relation: "intersects" } });
  if (kind === "refused") request.refuse(409, "name_taken", "This name is taken.");
  else request.cut();
  await flush; panel.render();
  expect.soft(panel.value.values).toEqual({ ...effective, name: "My Output" });
  if (kind === "refused") expect(panel.value.refusals.name).toBe("This name is taken.");
  panel.unmount(); panel = new HookHarness(() => usePanelDraft(props));
  expect(panel.value.values).toEqual({ ...effective, name: "My Output" });
  if (kind === "refused") expect(panel.value.refusals.name).toBe("This name is taken.");
  else {
    const failure = c.states.at(-1)!;
    if (failure.kind !== "failed") throw new Error("No name Retry");
    failure.retry();
    c.w.pending("PATCH", patch)[0].cut(); await c.w.settle(); panel.render();
    expect(panel.value.values).toEqual({ ...effective, name: "My Output" });
  }
  panel.value.set("name", "Next Output", false); panel.render();
  expect(panel.value.values).toEqual({ ...effective, name: "Next Output" });
});

it.each(["node", "all"])("accepted pending-save control sends the newest definition before %s starts once", async (mode) => {
  const c = setup(); await c.w.settle();
  const edit = c.editor.edit("a", { distance: 99 });
  const running = mode === "node" ? c.runner.runNode("a") : c.runner.start({});
  await c.w.settle(); expect(c.w.calls.filter((x) => x.method === "POST")).toHaveLength(0);
  expect(c.w.pending("PATCH", patch)[0].body).toEqual({ parameters: { distance: 99 } });
  c.w.pending("PATCH", patch)[0].ok({ step: stepOf("a", { distance: 99 }), applied: "active" }); await edit; await c.w.settle();
  const start = c.w.calls.filter((x) => x.method === "POST"); expect(start).toHaveLength(1);
  start[0].ok({ run: { id: "r", recipeId: "w", kind: mode === "node" ? "single" : "run_all", outcome: null, cancelled: false, startedAt: "2026-09-06", finishedAt: null, members: [] } });
  expect(await running).toMatchObject({ kind: "started" });
});

it("unreadable edit failure reaches the Run all notice's existing reason suffix", async () => {
  const c = setup(); await c.w.settle(); const edit = c.editor.edit("a", { distance: 99 });
  c.w.pending("PATCH", patch)[0].truncated(); await c.w.settle(); c.w.pending("GET", patch)[0].ok({ step: stepOf("a", { distance: 10 }) }); await edit;
  const flow = new HookHarness(() => useRunConfirm({ runner: c.runner })); const asking = flow.value.askRun(null);
  await asking; flow.render();
  expect(c.w.pending("POST", "/api/recipes/w/runs")).toHaveLength(0);
  expect(flow.value.refusal?.message).toBe("Couldn't save the change, so nothing started. Couldn't confirm the change was saved.");
  expect(c.w.calls.filter((x) => x.method === "POST" && !(x.body as { plan?: boolean })?.plan)).toHaveLength(0);
});
