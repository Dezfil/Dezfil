import { afterEach, expect, it, vi } from "vitest";
import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";
import { EMPTY_HISTORY, type History, type RecipeStep } from "./canvas-history";
import { wire, type WireCall } from "./fetch-wire";
import { readRecipe, runInverse, type OperationScreen } from "./history-operation";
import type { LayoutRead } from "./placement";
import type { SaveState } from "./use-layout-saves";
import { RecipeEditor } from "./use-recipe-edits";
import { WorkflowDocument } from "./workflow-document";

/**
 * A restoration whose add landed with its answer lost, then resumed: the
 * workflow moved to a new edit revision when the add landed, so the
 * resumed restoration's order must carry that revision. Sent with the
 * revision from before the restoration, the server refuses it as stale
 * and the editor halts on a change the page itself made.
 */

afterEach(() => vi.unstubAllGlobals());

const W = "w3";
const step = (id: string, ordinal: number, parameters: Record<string, unknown>): WorkflowStep => ({
  id, recipeId: W, ordinal, operation: "buffer", parameters, proposedParameters: null, output: null, origin: null,
  condition: "ready", conditions: ["ready"], causes: [], missingInputs: [], inputs: [], reads: [], latestAttempt: null, lastSuccessAt: null,
} as unknown as WorkflowStep);
const OTHER = step("other", 0, { input: "points", distance: 5, name: "other" });
const RESTORED = { input: "points", distance: 100, name: "old" };

it("a lost restoration answer, then the resumed order: the order carries the revision the add made and lands", async () => {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument(W);
  const before = { id: W, name: "Workflow", editRevision: "seen", projectId: null, steps: [OTHER] } as unknown as WorkflowListing;
  const layout: LayoutRead = { steps: { other: { x: 48, y: 40 } }, sources: {}, notes: [], updatedAt: null, editRevision: "seen" };
  document.install(before, layout);
  const whispers: SaveState[] = [];
  const editor = new RecipeEditor(W, { onState: (s) => whispers.push(s), onAccepted: () => undefined }, { lockReason: () => null, say: () => undefined }, document);
  // The node was removed from the head of the order; undoing it brings it back there.
  const removal: RecipeStep = {
    kind: "recipe", nodeId: "old", watermarks: { old: null }, label: "old removed",
    op: { kind: "remove", operation: "buffer", parameters: RESTORED, position: { x: 48, y: 120 }, ordinal: 0, dataset: "never" },
  };
  let history: History = { ...EMPTY_HISTORY, past: [removal] };
  const said: string[] = [];
  const screen: OperationScreen = {
    lockReason: null, say: (text) => said.push(text), failed: (message, retry) => whispers.push({ kind: "failed", message, retry }),
    recovered: () => whispers.push({ kind: "saved" }), runWord: () => null, stored: () => ({ other: { x: 48, y: 40 } }),
    dropNode: () => undefined, placeNode: () => undefined,
  };
  const press = () => runInverse(removal, "undo", {
    edits: editor, screen: () => screen, read: () => readRecipe(W), record: () => history,
    put: (next) => { history = next; }, labelOf: (id) => id, answered: () => undefined, forget: () => undefined,
    enqueue: (job) => void job(),
  });
  // The server's side: the add lands at revision "added"; a write carrying
  // any other revision after it is refused as stale.
  const afterAdd = { ...before, editRevision: "added", steps: [OTHER, step("fresh", 1, RESTORED)] } as unknown as WorkflowListing;
  const answerMove = (move: WireCall) => move.headers.get(EDIT_REVISION_HEADER) === "added"
    ? move.ok({ editRevision: "moved" })
    : move.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");

  const undo = press();
  await w.settle();
  w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: before });
  await w.settle();
  const add = w.pending("POST", `/api/recipes/${W}/steps`);
  expect(add).toHaveLength(1);
  expect(add[0].headers.get(EDIT_REVISION_HEADER)).toBe("seen");
  // The add lands on the server; the browser never hears its answer.
  add[0].cut();
  await w.settle();
  // The page confirms what landed by reading the workflow and its layout.
  w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: afterAdd });
  w.pending("GET", `/api/recipes/${W}/layout`)[0].ok({ layout: { ...layout, editRevision: "added" } });
  await undo;
  expect(said.at(-1)).toMatch(/^Not undone: /);
  const failed = [...whispers].reverse().find((s) => s.kind === "failed");
  expect(failed?.kind).toBe("failed");

  // Retry resumes the restoration: it reads, adopts the node the add made
  // and sends only the order.
  if (failed?.kind === "failed") failed.retry();
  await w.settle();
  w.pending("GET", `/api/recipes/${W}`)[0].ok({ recipe: afterAdd });
  await w.settle();
  expect(w.pending("POST", `/api/recipes/${W}/steps`)).toEqual([]);
  const move = w.pending("POST", `/api/recipes/${W}/steps/fresh/move`);
  expect(move).toHaveLength(1);
  expect(move[0].headers.get(EDIT_REVISION_HEADER)).toBe("added");
  answerMove(move[0]);
  await w.settle();
  await editor.idle();
  expect(document.stale).toBe(false);
  expect(said.at(-1)).toBe("Undone: old removed");
  expect(history.past).toEqual([]);
  expect(whispers.at(-1)).toEqual({ kind: "saved" });
});
