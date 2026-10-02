import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
import { HookHarness } from "./hook-harness";
import { useRecipeRefresh } from "./use-recipe-refresh";
import { useWorkflowRun } from "./use-workflow-run";
import { WorkflowDocument } from "./workflow-document";
import { RecipeEditor } from "./use-recipe-edits";
import { wire } from "./fetch-wire";
import type { PageRead } from "./workflow-read";
import type { WorkflowListing } from "../workflow-model";
import type { WorkflowRun } from "./run-overlay";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });
it.each([false, true])("settles a promoted run without rebasing queued edits (pending: %s)", async (pending) => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w");
  const recipe = { id: "w", editRevision: "planned", steps: [{ id: "a", parameters: { sql: "SELECT 1" }, proposedParameters: { sql: "SELECT 2" } }] } as unknown as WorkflowListing;
  const layout = { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "planned" };
  document.install(recipe, layout);
  let live: PageRead | null = { recipe, layout, tables: [], operations: [] };
  const refresh = new HookHarness(() => useRecipeRefresh("w", document, (value) => { live = typeof value === "function" ? value(live) : value; }));
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const runner = new HookHarness(() => useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: refresh.value, onTablesChanged: async () => true, onRunSeen() {} }, document));
  cleanups.push(() => refresh.unmount(), () => runner.unmount());
  const edit = pending ? editor.edit("a", { sql: "SELECT 3" }) : null;
  const run: WorkflowRun = { id: "r", recipeId: "w", kind: "single", outcome: null, cancelled: false, startedAt: "now", finishedAt: null, members: [] };
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [run] }); await w.settle();
  w.pending("GET", "/api/recipes/w/runs/r")[0].ok({ run: { ...run, outcome: "completed" } }); await w.settle();
  const promoted = { ...recipe, editRevision: "promoted", steps: [{ ...recipe.steps[0], parameters: { sql: "SELECT 2" }, proposedParameters: null }] };
  w.pending("GET", "/api/recipes/w")[0].ok({ recipe: promoted }); await w.settle();
  expect(runner.value.state).toMatchObject({ phase: "idle", overlaid: false, readFailure: null, active: null });
  expect(live?.recipe).toEqual(promoted);
  expect(document.revision).toBe("planned");
  if (edit) {
    expect(editor.drafts.get("a")?.parameters.sql).toBe("SELECT 3");
    const request = w.pending("PATCH", "/api/recipes/w/steps/a")[0];
    expect(request.headers.get("X-Edit-Revision")).toBe("planned");
    request.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
    expect(await edit).toMatchObject({ kind: "refused", code: "stale_revision" });
    expect(editor.drafts.get("a")?.parameters.sql).toBe("SELECT 3");
  }
  w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [{ ...run, outcome: "completed" }] }); await w.settle();
});
