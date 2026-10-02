import { afterEach, expect, it, vi } from "vitest";
import { wire } from "./fetch-wire";
import { WorkflowDocument } from "./workflow-document";
import { LayoutSaveCoordinator, type SaveState } from "./layout-save-coordinator";
import { RecipeEditor } from "./use-recipe-edits";
import type { WorkflowListing } from "../workflow-model";

afterEach(() => vi.unstubAllGlobals());
it("a stale layout keeps the last accepted position and halts queued definitions without offering Retry or Saved", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const doc = new WorkflowDocument("w");
  const layout = { steps: { n: { x: 0, y: 0 } }, sources: {}, notes: [], updatedAt: null, editRevision: "seen" };
  const recipe = { id: "w", steps: [{ id: "n", parameters: { distance: 10 } }], editRevision: "seen" } as unknown as WorkflowListing;
  doc.install(recipe, layout);
  const states: SaveState[] = [];
  const ports = { onState: (state: SaveState) => states.push(state), lockReason: () => null, say() {}, onAccepted() {} };
  const saves = new LayoutSaveCoordinator("w", layout, { ...ports, graph: { members: [], edges: [], presentSourceCount: 0 } }, doc);
  const edits = new RecipeEditor("w", ports, ports, doc);
  saves.save({ positions: { n: { x: 100, y: 50 } }, notes: [] });
  const params = edits.edit("n", { distance: 20 });
  saves.save({ positions: { n: { x: 120, y: 80 } }, notes: [] });
  w.calls[0].refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  await w.settle();
  expect(w.calls).toHaveLength(1);
  await params; await doc.idle();
  expect(states.at(-1)).toMatchObject({ kind: "stale" });
  expect(states.at(-1)).not.toHaveProperty("retry");
  expect(doc.layout).toEqual(layout);
  expect(edits.drafts.get("n")?.displayValues).toEqual({ distance: 20 });
  expect(doc.refresh({ ...recipe, editRevision: "foreign" })).toBe(false);
  expect(doc.revision).toBe("seen");
});

it("rejects a mismatched reload without changing the refused editor", async () => {
  const { readWorkflowPage } = await import("./workflow-read");
  const doc = new WorkflowDocument("w");
  doc.revision = "seen"; doc.halt();
  vi.stubGlobal("fetch", async (url: string) => Response.json(
    url.endsWith("/layout") ? { layout: { editRevision: "other", steps: {}, sources: {}, notes: [] } } :
    url.endsWith("/w") ? { recipe: { editRevision: "current", steps: [] } } :
    url.endsWith("/operations") ? { operations: [] } : { tables: [] },
  ));
  await expect(readWorkflowPage("w")).rejects.toThrow("This item has changed.");
  expect(doc.stale).toBe(true);
  expect(doc.revision).toBe("seen");
});
