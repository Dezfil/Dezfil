import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installDomHost } from "../testing/dom-host";
import type { WorkflowListing } from "../workflow-model";
import { WorkflowDocument } from "./workflow-document";
import { useRecipeRefresh } from "./use-recipe-refresh";
import { useWorkflowRun, type WorkflowRunner } from "./use-workflow-run";
import { useWorkflowEditorPort } from "./use-workflow-editor-port";
import type { DocumentEditorPort } from "../document-editor-context";
import { RecipeEditor } from "./use-recipe-edits";
import { RunContext, useRunner } from "./run-context";
import { RunDock } from "./RunDock";
import type { PageRead } from "./workflow-read";
import type { WorkflowRun } from "./run-overlay";
import { wire } from "./fetch-wire";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["completed", "failed"] as const)("ends a canvas-started run when an embedded turn observes its outcome (%s)", async outcome => {
  vi.useFakeTimers();
  const host = installDomHost();
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w");
  const recipe = { id: "w", editRevision: "planned", steps: [{ id: "a", parameters: { sql: "SELECT 1" }, proposedParameters: { sql: "SELECT 2" } }] } as unknown as WorkflowListing;
  const layout = { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "planned" };
  document.install(recipe, layout);
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  let runner!: WorkflowRunner;
  let embedded!: DocumentEditorPort;
  function EmbeddedDock() {
    return <RunDock runner={useRunner()} refusal={null} onRunAll={() => {}} onDismissRefusal={() => {}} />;
  }
  function CanvasRun() {
    const [, setLive] = useState<PageRead | null>({ recipe, layout, tables: [], operations: [] });
    const refresh = useRecipeRefresh("w", document, setLive);
    runner = useWorkflowRun("w", { settle: editor.settled, onRecipeChanged: refresh, onTablesChanged: async () => true, onRunSeen() {} }, document);
    embedded = useWorkflowEditorPort("w", document, runner, async () => true, setLive);
    return <RunContext.Provider value={runner}><EmbeddedDock /></RunContext.Provider>;
  }
  const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
  await flush(() => root.render(<CanvasRun />));
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] }));
  let started!: ReturnType<WorkflowRunner["start"]>;
  await flush(() => { started = runner.start({ members: ["a"], editRevision: "planned" }); });
  const run: WorkflowRun = { id: "r", recipeId: "w", kind: "run_all", outcome: null, cancelled: false, startedAt: "now", finishedAt: null, members: [] };
  await flush(() => w.pending("POST", "/api/recipes/w/runs")[0].ok({ run, editRevision: "planned" }));
  expect(await started).toMatchObject({ kind: "started" });
  await flush(() => {
    w.pending("GET", "/api/recipes/w")[0].ok({ recipe });
    w.pending("GET", "/api/recipes/w/runs/r")[0].ok({ run });
  });
  expect(host.document.querySelector("[data-run-dock]")?.getAttribute("data-run-dock")).toBe("running");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const poll = w.pending("GET", "/api/recipes/w/runs/r")[0];
  const after = outcome === "completed" ? { ...recipe, editRevision: "promoted", steps: [{ ...recipe.steps[0], parameters: { sql: "SELECT 2" }, proposedParameters: null }] } : recipe;
  let turn!: Promise<void>;
  await flush(() => { turn = embedded.turn(async () => {}); });
  await flush(() => {
    w.pending("GET", "/api/recipes/w")[0].ok({ recipe: after });
    w.pending("GET", "/api/recipes/w/layout")[0].ok({ layout: { ...layout, editRevision: after.editRevision } });
  });
  await turn;
  const ended = { ...run, outcome, finishedAt: "later" };
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [ended] }));
  // Re-observation superseded the old poll. Its late answer cannot be
  // responsible for carrying the dock or embedded run context to completion.
  await flush(() => poll.ok({ run: ended }));
  expect(runner.state.phase).toBe("settling");
  await flush(() => w.pending("GET", "/api/recipes/w")[0].ok({ recipe: after }));
  expect(host.document.querySelector("[data-run-dock]")?.getAttribute("data-run-dock")).toBe("ended");
  expect(runner.state).toMatchObject({ phase: "idle", readFailure: null, active: null, overlaid: false, ended });
  expect(vi.getTimerCount()).toBe(0);
  expect(document.revision).toBe(after.editRevision);
  expect(document.recipe).toEqual(after);
  expect(document.layout?.editRevision).toBe(after.editRevision);
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [ended] }));
  const editing = editor.edit("a", { sql: "SELECT 3" });
  const edit = w.pending("PATCH", "/api/recipes/w/steps/a")[0];
  expect(edit.headers.get("X-Edit-Revision")).toBe(after.editRevision);
  edit.ok({ step: { ...after.steps[0], proposedParameters: { sql: "SELECT 3" } }, applied: "proposed", editRevision: "edited" });
  expect(await editing).toMatchObject({ kind: "accepted" });
  expect(document.stale).toBe(false);
});
