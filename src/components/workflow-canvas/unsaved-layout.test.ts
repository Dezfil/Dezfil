import { expect, it } from "vitest";
import { markUnsavedNodes, savedPosition } from "./unsaved-layout";
import type { FlowNode } from "./to-flow";
import type { LayoutRead } from "./placement";

it("marks only moved members and edited notes while preserving a ghost's saved coordinates", () => {
  const note = { id: "note", text: "saved", x: 30, y: 40, w: 200, h: 100, color: "yellow" as const };
  const layout: LayoutRead = { steps: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, sources: {}, notes: [note], updatedAt: null };
  const nodes = [
    { id: "a", type: "badge", position: { x: 10, y: 20 }, data: { member: { kind: "node" } } },
    { id: "b", type: "badge", position: { x: 3, y: 4 }, data: { member: { kind: "node" } } },
    { id: "note:note", type: "note", position: { x: 30, y: 40 }, data: { note: { ...note, text: "keep this text" } } },
  ] as FlowNode[];
  const marked = markUnsavedNodes(nodes, layout);
  expect(marked[0].data).toMatchObject({ unsavedPosition: true });
  expect(marked[1].data).toMatchObject({ unsavedPosition: false });
  expect(marked[2].data).toMatchObject({ unsaved: true });
  expect(savedPosition(marked[0], layout)).toEqual({ x: 1, y: 2 });
  expect(marked[0].position).toEqual({ x: 10, y: 20 });
  expect(markUnsavedNodes(nodes, null)).toBe(nodes);
});
