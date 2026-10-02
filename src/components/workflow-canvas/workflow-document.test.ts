import { afterEach, expect, it, vi } from "vitest";
import { WorkflowDocument } from "./workflow-document";
import { RecipeEditor } from "./use-recipe-edits";
import { LayoutSaveCoordinator } from "./layout-save-coordinator";
import { wire } from "./fetch-wire";
import type { WorkflowListing } from "../workflow-model";
import type { LayoutRead } from "./placement";

afterEach(() => vi.unstubAllGlobals());
it("orders definition, layout and another node using the accepted revision", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const document = new WorkflowDocument("w");
  const layout: LayoutRead = { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "initial" };
  document.install({ id: "w", editRevision: "initial", steps: [] } as unknown as WorkflowListing, layout);
  const editor = new RecipeEditor("w", { onAccepted() {}, onState() {} }, { lockReason: () => null, say() {} }, document);
  const positions = new LayoutSaveCoordinator("w", layout, { graph: { members: [], edges: [], presentSourceCount: 0 }, onState() {}, lockReason: () => null, say() {} }, document);
  const first = editor.edit("a", { name: "first" });
  positions.save({ positions: { a: { x: 5, y: 10 } }, notes: [] });
  const second = editor.edit("b", { name: "second" });
  await w.settle();
  expect(w.calls.map((c) => c.method)).toEqual(["PATCH"]);
  w.calls[0].ok({ step: { id: "a", parameters: { name: "first" } }, applied: "active", editRevision: "definition" });
  await first; await w.settle();
  expect(w.calls[1].method).toBe("PUT");
  expect(w.calls[1].headers.get("X-Edit-Revision")).toBe("definition");
  w.calls[1].ok({ layout: { ...layout, steps: { a: { x: 5, y: 10 } }, editRevision: "layout" }, editRevision: "layout" });
  await w.settle();
  expect(w.calls[2].headers.get("X-Edit-Revision")).toBe("layout");
  w.calls[2].ok({ step: { id: "b", parameters: { name: "second" } }, applied: "active", editRevision: "second" });
  await second;
  expect(document.revision).toBe("second");
});

it("refuses mixed definition and layout reads and ignores refreshes while intent waits", async () => {
  const document = new WorkflowDocument("w");
  const recipe = { id: "w", editRevision: "one", steps: [] } as unknown as WorkflowListing;
  const layout = { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "two" } as LayoutRead;
  expect(() => document.install(recipe, layout)).toThrow(/changed/);
  document.install(recipe, { ...layout, editRevision: "one" });
  let finish!: () => void;
  const flight = document.enqueue(() => new Promise<void>((resolve) => { finish = resolve; }));
  expect(document.refresh({ ...recipe, editRevision: "poll" })).toBe(false);
  expect(document.revision).toBe("one");
  finish(); await flight;
});
