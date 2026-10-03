import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
import { HookHarness } from "./hook-harness";
import { useRunConfirm } from "./use-run-confirm";
import { useWorkflowRun } from "./use-workflow-run";
import { WorkflowDocument } from "./workflow-document";
import { RecipeEditor } from "./use-recipe-edits";
import { LayoutSaveCoordinator } from "./layout-save-coordinator";
import { wire } from "./fetch-wire";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
it("starts the confirmed middle-node plan after a promotion without rebasing local edits", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w"); document.accept({ editRevision: "before-promotion" });
  const h = new HookHarness(() => useWorkflowRun("w", { settle: async () => null, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }, document));
  const flow = new HookHarness(() => useRunConfirm({ runner: h.value }));
  cleanups.push(() => { flow.unmount(); h.unmount(); });
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] });
  const asking = flow.value.askRun({ id: "b", label: "Middle" }); await w.settle();
  w.pending("POST", "/api/recipes/w/runs")[0].ok({ plan: { kind: "from_step", wide: true, members: ["b", "c"] }, editRevision: "promoted" });
  await asking; flow.render();
  const confirming = flow.value.confirmRun(); await w.settle();
  const starts = w.pending("POST", "/api/recipes/w/runs");
  expect(starts).toHaveLength(1);
  expect(starts[0].headers.get("X-Edit-Revision")).toBe("promoted");
  expect(starts[0].body).toEqual({ fromStepId: "b", members: ["b", "c"] });
  starts[0].ok({ run: { id: "r", recipeId: "w", kind: "from_step", outcome: null, members: [] } });
  await confirming; flow.render();
  expect(flow.value.confirm).toBeNull();
  expect(flow.value.refusal).toBeNull();
  expect(document.revision).toBe("before-promotion");
});

it("plans after definition and layout settle, and keeps the displayed plan's basis through start", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w"); document.accept({ editRevision: "initial" });
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const layouts = new LayoutSaveCoordinator("w", { steps: {}, sources: {}, notes: [], updatedAt: null }, { graph: { members: [], edges: [], presentSourceCount: 0 }, onState() {}, lockReason: () => null, say() {} }, document);
  const h = new HookHarness(() => useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }, document));
  cleanups.push(() => h.unmount());
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] });
  const edit = editor.edit("a", { name: "new" });
  layouts.save({ positions: { a: { x: 1, y: 2 } }, notes: [] });
  const planning = h.value.plan(); await w.settle();
  expect(w.pending("POST", "/api/recipes/w/runs")).toHaveLength(0);
  w.pending("PATCH", "/api/recipes/w/steps/a")[0].ok({ step: { id: "a", parameters: { name: "new" } }, editRevision: "edited" });
  await edit; await w.settle();
  expect(w.pending("POST", "/api/recipes/w/runs")).toHaveLength(0);
  w.pending("PUT", "/api/recipes/w/layout")[0].ok({ layout: { steps: { a: { x: 1, y: 2 } }, sources: {}, notes: [], updatedAt: "now" }, editRevision: "planned" });
  await w.settle();
  w.pending("POST", "/api/recipes/w/runs")[0].ok({ plan: { kind: "run_all", wide: false, members: ["a"] }, editRevision: "planned" });
  expect(await planning).toMatchObject({ editRevision: "planned" });
  document.accept({ editRevision: "later" });
  const starting = h.value.start({ members: ["a"], editRevision: "planned" }); await w.settle();
  const start = w.pending("POST", "/api/recipes/w/runs")[0];
  expect(start.headers.get("X-Edit-Revision")).toBe("planned");
  expect(start.body).toEqual({ members: ["a"] });
  start.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  expect(await starting).toMatchObject({ kind: "refused", code: "stale_revision", retryable: false });
  expect(w.calls.filter((call) => call.method === "POST")).toHaveLength(2);
});

it.each(["failed", "refused", "pending failure"])("Run all shows confirmation with a %s save, then refuses the start", async (kind) => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w"); document.accept({ editRevision: "accepted" });
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const h = new HookHarness(() => useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }, document));
  const flow = new HookHarness(() => useRunConfirm({ runner: h.value }));
  cleanups.push(() => { flow.unmount(); h.unmount(); });
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] });
  const edit = editor.edit("a", { sql: "SELECT 99" });
  const reject = () => w.pending("PATCH", "/api/recipes/w/steps/a")[0].refuse(kind === "refused" ? 422 : 500, "seeded_failure", "The seeded save failed.");
  if (kind !== "pending failure") { reject(); await edit; }
  const asking = flow.value.askRun(null); await w.settle();
  expect(w.pending("POST", "/api/recipes/w/runs"), "the confirmation plan must not wait on a failed save").toHaveLength(1);
  w.pending("POST", "/api/recipes/w/runs")[0].ok({ plan: { kind: "run_all", wide: true, members: ["a", "b"] }, editRevision: "accepted" });
  await asking; flow.render();
  expect(flow.value.confirm?.plan.members).toEqual(["a", "b"]);
  const confirming = flow.value.confirmRun(); await w.settle();
  if (kind === "pending failure") { reject(); await edit; }
  await confirming; flow.render();
  expect(flow.value.refusal?.message).toBe("Couldn't save the change, so nothing started. The seeded save failed.");
  expect(w.calls.filter(call => call.method === "POST" && !(call.body as { plan?: boolean }).plan)).toHaveLength(0);
});

it("asks again when an accepted pending save changes a confirmation preview", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w"); document.accept({ editRevision: "before" });
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const h = new HookHarness(() => useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: async () => true, onTablesChanged: async () => true, onRunSeen() {} }, document));
  cleanups.push(() => h.unmount());
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] });
  const edit = editor.edit("a", { sql: "SELECT 99" });
  const starting = h.value.start({ members: ["a", "b"], editRevision: "before", preview: true }); await w.settle();
  w.pending("PATCH", "/api/recipes/w/steps/a")[0].ok({ step: { id: "a", parameters: { sql: "SELECT 99" } }, editRevision: "after" });
  await edit;
  expect(await starting).toMatchObject({ kind: "refused", code: "plan_changed" });
  expect(document.stale).toBe(false);
  expect(w.pending("POST", "/api/recipes/w/runs")).toHaveLength(0);
});
