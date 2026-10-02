import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SharedHistoryControls } from "./SharedHistoryControls";

it("discloses the shared target and original author before pressing, including a blocked whole group", () => {
  const history: import("./shared-history").SharedHistory = { canUndo: true, canRedo: true, undoTarget: { eligible: false, reason: "Only the owner can change publication settings.", steps: [
    { id: "a", scope: "layer", targetId: "stations", op: "update", author: { name: "Ada Okafor", sqlName: "ada" }, createdAt: "now" },
    { id: "b", scope: "map", targetId: "map", op: "update", author: { name: "Ada Okafor", sqlName: "ada" }, createdAt: "now" },
  ] }, redoTarget: { eligible: true, reason: null, steps: [{ id: "c", scope: "layer", targetId: "stations", op: "delete", author: null, createdAt: "old" }] } };
  const html = renderToStaticMarkup(<SharedHistoryControls history={history} onUndo={() => {}} onRedo={() => {}} />);
  expect(html).toContain("Ada Okafor (ada)");
  expect(html).toContain("stations");
  expect(html).toContain("Only the owner can change publication settings.");
  expect(html).toContain("Unknown");
  expect(html.match(/disabled=""/g)).toHaveLength(1);
});
