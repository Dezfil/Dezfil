import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";
import type { LayoutRead } from "./placement";
import { additionRecovery } from "./addition-recovery";
import { WorkflowDocument } from "./workflow-document";
import { RecipeEditor } from "./use-recipe-edits";
import { wire } from "./fetch-wire";
import type { SaveState } from "./layout-save-coordinator";

afterEach(() => vi.unstubAllGlobals());
const input = { operation: "sql", parameters: { name: "restored", sql: "SELECT 1" } };
function setup() {
  const document = new WorkflowDocument("w");
  const old = { id: "a", recipeId: "w", ordinal: 0, ...input, origin: null, parameters: { name: "first", sql: "SELECT 2" }, proposedParameters: null, lastSuccessAt: null, output: null } as unknown as WorkflowStep;
  const before = { id: "w", name: "Workflow", editRevision: "seen", projectId: null, steps: [old] } as unknown as WorkflowListing;
  const layout: LayoutRead = { steps: { a: { x: 288, y: 40 }, removed: { x: 576, y: 40 } }, sources: {}, notes: [], updatedAt: null, editRevision: "seen" };
  document.install(before, layout);
  const recipe: WorkflowListing = { ...before, editRevision: "added", steps: [old, { ...old, id: "b", ordinal: 1, parameters: input.parameters }] };
  const positions: LayoutRead = { ...layout, steps: { a: layout.steps.a }, editRevision: "added" };
  const fetch = vi.fn(async (path: string) => Response.json(path.endsWith("/layout") ? { layout: positions } : { recipe }));
  vi.stubGlobal("fetch", fetch);
  return { document, before, layout, recipe, positions, fetch };
}

it("adopts the complete addition and prunes an already removed node's saved position", async () => {
  const c = setup();
  await additionRecovery(c.document, input)();
  expect(c.document.revision).toBe("added");
  expect(c.document.recipe).toEqual(c.recipe);
  expect(c.document.layout).toEqual(c.positions);
  expect(c.fetch).toHaveBeenCalledTimes(2);
});

it.each(["name", "parameters", "origin", "order", "notes", "position", "mixed reads", "unchanged revision", "extra node", "run", "unreadable", "stale", "disposed", "translated"])("does not establish a new basis for a lost addition with %s", async conflict => {
  const c = setup();
  const recover = additionRecovery(c.document, conflict === "translated" ? { ...input, writtenIn: { kind: "workflow", id: "elsewhere" } } : input);
  if (conflict === "name") c.recipe.name = "Changed elsewhere";
  if (conflict === "parameters") c.recipe.steps = [{ ...c.recipe.steps[0], parameters: { ...c.recipe.steps[0].parameters, sql: "SELECT 3" } }, c.recipe.steps[1]];
  if (conflict === "origin") c.recipe.steps = [{ ...c.recipe.steps[0], origin: { sql: "SELECT 3" } } as WorkflowStep, c.recipe.steps[1]];
  if (conflict === "order") c.recipe.steps.reverse();
  if (conflict === "notes") c.positions.notes = [{ id: "note", text: "Someone else's note", x: 0, y: 0, width: 100, height: 100, color: "yellow" } as unknown as LayoutRead["notes"][number]];
  if (conflict === "position") c.positions.steps = { a: { x: 400, y: 200 } };
  if (conflict === "mixed reads") c.positions.editRevision = "elsewhere";
  if (conflict === "unchanged revision") c.recipe.editRevision = c.positions.editRevision = "seen";
  if (conflict === "extra node") c.recipe.steps.push({ ...c.recipe.steps[1], id: "c", ordinal: 2 });
  if (conflict === "run") c.recipe.steps[1].lastSuccessAt = "now";
  if (conflict === "unreadable") c.fetch.mockRejectedValue(new Error("Offline"));
  if (conflict === "stale") c.document.halt();
  if (conflict === "disposed") c.document.dispose();
  await recover();
  expect(c.document.revision).toBe("seen");
  expect(c.document.recipe).toBe(c.before);
  expect(c.document.layout).toBe(c.layout);
  if (["stale", "disposed", "translated"].includes(conflict)) expect(c.fetch).not.toHaveBeenCalled();
});

it("leaves a newer accepted basis intact when recovery answers late", async () => {
  const c = setup();
  c.fetch.mockImplementation(async path => {
    c.document.accept({ editRevision: "newer" });
    return Response.json(path.endsWith("/layout") ? { layout: c.positions } : { recipe: c.recipe });
  });
  await additionRecovery(c.document, input)();
  expect(c.document.revision).toBe("newer");
  expect(c.document.recipe).toBe(c.before);
});

it.each(["cut", "truncated", "bodyFailure"] as const)("a %s addition's coordinator Retry returns the confirmed node without a second POST", async failure => {
  const c = setup(), w = wire();
  const read = c.fetch.getMockImplementation()!;
  c.fetch.mockImplementation((path, ...args: unknown[]) => (args[0] as RequestInit | undefined)?.method === "POST"
    ? w.fetch(path, args[0] as RequestInit) : read(path));
  const states: SaveState[] = [];
  const editor = new RecipeEditor("w", { onState: state => states.push(state), onAccepted() {} }, { lockReason: () => null, say() {} }, c.document);
  const pending = editor.add(input);
  w.pending("POST", "/api/recipes/w/steps")[0][failure]();
  expect(await pending).toMatchObject({ kind: "failed" });
  expect(c.document.revision).toBe("added");
  const state = states.at(-1)!;
  expect(state.kind).toBe("failed");
  if (state.kind === "failed") state.retry();
  await editor.idle();
  expect(states.at(-1)).toEqual({ kind: "saved" });
  expect(w.calls).toHaveLength(1);
  expect(c.document.recipe?.steps.map(step => step.id)).toEqual(["a", "b"]);
});
