import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async original => ({ ...await original<object>(), ...(await import("./hook-harness")).hookReact }));
import { HookHarness } from "./hook-harness";
import { useCanvasHistory, type HistoryPorts } from "./use-canvas-history";
import { RecipeEditor } from "./use-recipe-edits";
import { WorkflowDocument } from "./workflow-document";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";
import { STALE_MESSAGE } from "../document-sequence";
import { wire } from "./fetch-wire";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
it.each([true, false])("undo observes a headless run without rebasing its inverse (ran: %s)", async ran => {
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  const w = wire();
  const step = { id: "a", operation: "buffer", ordinal: 0, parameters: { distance: 100 }, proposedParameters: null, lastSuccessAt: null, output: null, condition: "ready", conditions: ["ready"], causes: [], missingInputs: [], inputs: [], reads: [], latestAttempt: null } as WorkflowStep;
  vi.stubGlobal("fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return Response.json({ error: { code: "stale_revision", message: STALE_MESSAGE } }, { status: 409 });
    if (!init?.method || init.method === "GET") return Response.json({ recipe: { editRevision: "headless", steps: [{ ...step, lastSuccessAt: ran ? "now" : null }] } });
    return w.fetch(path, init);
  });
  const document = new WorkflowDocument("w");
  document.install({ id: "w", editRevision: "before", steps: [] } as unknown as WorkflowListing, { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "before" });
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const said: string[] = [];
  const ports: HistoryPorts = {
    positionOf: () => null, lockReason: null, say: text => said.push(text), failed() {}, recovered() {}, commitNoteEditor() {}, settleLayoutSave() {}, flushPanel: async () => null,
    snapshot: () => ({ positions: {}, notes: [] }), applyPositions() {}, applyNotes() {}, writeBack() {}, glideAndFit() {}, runWord: () => null, stored: () => ({}), dropNode() {}, placeNode() {},
  };
  const h = new HookHarness(() => useCanvasHistory({ id: "w", edits: editor, graph: { members: [], edges: [], presentSourceCount: 0 }, operations: [], ports: { current: ports } }));
  cleanups.push(() => h.unmount());
  const adding = h.value.edits.add({ operation: "buffer", parameters: step.parameters });
  w.pending("POST", "/api/recipes/w/steps")[0].ok({ step, editRevision: "added" });
  await adding; h.render(); expect(h.value.canUndo).toBe(true);
  h.value.press("undo"); await w.settle(); await w.settle(); h.render();
  expect(said.at(-1)).toContain(ran ? "run" : STALE_MESSAGE);
  expect(document.revision).toBe("added");
  expect(document.stale).toBe(!ran);
  expect(h.value.canUndo).toBe(!ran);
});
