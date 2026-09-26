import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipeEditor, type EditOutcome } from "./use-recipe-edits";
import { wire } from "./fetch-wire";
import type { SaveState } from "./use-layout-saves";
import type { WorkflowStep } from "../workflow-model";
const path = "/api/recipes/w/steps/a";
const before = { distance: 10, input: "points" };
const sent = { distance: 99, input: "points" };
const next = { distance: 120, input: "points" };
const step = (parameters: Record<string, unknown>, proposedParameters: Record<string, unknown> | null = null) => ({ id: "a", parameters, proposedParameters } as WorkflowStep);
function setup() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const states: SaveState[] = []; const accepted = vi.fn();
  const editor = new RecipeEditor("w", { onState: (s) => states.push(s), onAccepted: accepted }, { lockReason: () => null, say() {} });
  return { w, editor, states, accepted };
}
const observe = <T,>(p: Promise<T>) => { const result: { value: T | "pending" | "rejected" } = { value: "pending" }; void p.then((v) => { result.value = v; }, () => { result.value = "rejected"; }); return result; };
afterEach(() => vi.unstubAllGlobals());

describe("unreadable edit success", () => {
  it.each(["truncated", "bodyFailure"] as const)("%s settles edit, queued successor and waiting actions after immediate reconciliation", async (body) => {
    const c = setup(); const first = observe(c.editor.edit("a", sent));
    const queued = observe(c.editor.edit("a", next)); const waiting = observe(c.editor.settled()); const idle = observe(c.editor.idle());
    c.w.pending("PATCH", path)[0][body](); await c.w.settle();
    expect(c.w.pending("GET", path)).toHaveLength(1);
    expect(c.w.calls.filter((x) => x.method === "PATCH")).toHaveLength(1);
    c.w.pending("GET", path)[0].ok({ step: step(before) }); await c.w.settle();
    expect(first.value).toMatchObject({ kind: "failed", message: "Couldn't confirm the change was saved." });
    expect(c.w.pending("PATCH", path)[0].body).toEqual({ parameters: next });
    c.w.pending("PATCH", path)[0].ok({ step: step(next), applied: "active" }); await c.w.settle();
    expect(queued.value).toMatchObject({ kind: "accepted" }); expect(waiting.value).toBeNull(); expect(idle.value).toBeUndefined();
  });

  it.each(["active", "proposed"] as const)("recognizes hidden %s acceptance immediately with no Retry and no replay", async (applied) => {
    const c = setup(); const outcome = observe(c.editor.edit("a", sent)); c.w.pending("PATCH", path)[0].truncated(); await c.w.settle();
    expect(c.w.pending("GET", path)).toHaveLength(1);
    c.w.pending("GET", path)[0].ok({ step: applied === "active" ? step({ input: "points", distance: 99 }) : step(before, sent) }); await c.w.settle();
    expect(outcome.value).toMatchObject({ kind: "accepted", applied }); expect(await c.editor.settled()).toBeNull();
    expect(c.states.at(-1)?.kind).toBe("saved"); expect(c.accepted).toHaveBeenCalledOnce();
    expect(c.w.calls.filter((x) => x.method === "PATCH")).toHaveLength(1);
  });

  it("read precedes a queued successor without erasing its newer draft", async () => {
    const c = setup(); const first = c.editor.edit("a", sent); const queued = c.editor.edit("a", next);
    c.w.pending("PATCH", path)[0].truncated(); await c.w.settle(); expect(c.w.pending("GET", path)).toHaveLength(1);
    c.w.pending("GET", path)[0].ok({ step: step(sent) }); await c.w.settle();
    expect((await first).kind).toBe("accepted"); expect(c.editor.drafts.get("a")?.parameters).toEqual(next);
    expect(c.w.calls.map((x) => x.method)).toEqual(["PATCH", "GET", "PATCH"]);
    c.w.pending("PATCH", path)[0].ok({ step: step(next), applied: "active" }); await queued;
    expect(c.editor.drafts.get("a")).toBeNull();
  });

  it.each(["accepted", "not accepted"])("failed reads settle all callers; Retry reads before sending when later %s", async (answer) => {
    const c = setup(); const first = observe(c.editor.edit("a", sent)); const barrier = observe(c.editor.settled());
    c.w.pending("PATCH", path)[0].bodyFailure(); await c.w.settle(); expect(c.w.pending("GET", path)).toHaveLength(1);
    c.w.pending("GET", path)[0].cut(); await c.w.settle();
    expect(first.value).toMatchObject({ kind: "failed" }); expect(barrier.value).toMatchObject({ kind: "failed" });
    expect(await c.editor.settled()).toMatchObject({ kind: "failed", message: "Couldn't confirm the change was saved." });
    const failed = c.states.at(-1)!; if (failed.kind !== "failed") throw new Error("No Retry"); failed.retry(); await c.w.settle();
    expect(c.w.calls.map((x) => x.method)).toEqual(["PATCH", "GET", "GET"]);
    c.w.pending("GET", path)[0].ok({ step: step(answer === "accepted" ? sent : before) }); await c.w.settle();
    if (answer !== "accepted") { expect(c.w.pending("PATCH", path)).toHaveLength(1); c.w.pending("PATCH", path)[0].ok({ step: step(sent), applied: "active" }); await c.w.settle(); }
    expect(await c.editor.settled()).toBeNull();
    expect(c.w.calls.filter((x) => x.method === "PATCH")).toHaveLength(answer === "accepted" ? 1 : 2);
  });

  it("failed reconciliation of a queued edit settles without replaying either change", async () => {
    const c = setup(); const first = observe(c.editor.edit("a", sent)); const queued = observe(c.editor.edit("a", next)); const waiting = observe(c.editor.settled());
    c.w.pending("PATCH", path)[0].truncated(); await c.w.settle(); expect(c.w.pending("GET", path)).toHaveLength(1);
    c.w.pending("GET", path)[0].cut(); await c.w.settle();
    c.w.pending("GET", path)[0].cut(); await c.w.settle();
    for (const result of [first, queued, waiting]) expect(result.value).toMatchObject({ kind: "failed" });
    expect(c.w.calls.filter((x) => x.method === "PATCH")).toHaveLength(1); expect(c.editor.drafts.get("a")?.parameters).toEqual(next);
  });

  it.each(["cut", "4xx", "5xx", "clean"])("%s control settles and a subsequent edit proceeds", async (answer) => {
    const c = setup(); const outcome = observe(c.editor.edit("a", sent)); const call = c.w.pending("PATCH", path)[0];
    if (answer === "cut") call.cut(); else if (answer === "clean") call.ok({ step: step(sent), applied: "active" }); else call.refuse(answer === "4xx" ? 422 : 500, "invalid", "Cannot save");
    await c.w.settle(); expect(outcome.value).toMatchObject({ kind: answer === "clean" ? "accepted" : answer === "4xx" ? "refused" : "failed" });
    const second = c.editor.edit("a", next); c.w.pending("PATCH", path)[0].ok({ step: step(next), applied: "active" }); expect((await second).kind).toBe("accepted"); expect(await c.editor.settled()).toBeNull();
  });

  it("control: unreadable 200 removal settles its caller as failed", async () => {
    const c = setup(); const result = observe(c.editor.remove("a")); await c.w.settle(); c.w.pending("DELETE", path)[0].truncated(); await c.w.settle();
    expect(result.value).toMatchObject({ kind: "failed" });
  });

  it("unconfirmed edit carries its sentence into the settled Run refusal reason", async () => {
    const c = setup(); const result = observe(c.editor.edit("a", sent)); c.w.pending("PATCH", path)[0].truncated(); await c.w.settle();
    expect(c.w.pending("GET", path)).toHaveLength(1); c.w.pending("GET", path)[0].ok({ step: step(before) }); await c.w.settle();
    const failure = await c.editor.settled() as Extract<EditOutcome, { kind: "failed" }>;
    expect(result.value).toEqual(failure); expect(failure.message).toBe("Couldn't confirm the change was saved.");
  });
});
