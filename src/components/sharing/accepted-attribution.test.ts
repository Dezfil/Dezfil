import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RunInitiator } from "./RunInitiator";
import { expect, it } from "vitest";
import { acceptedMapWrite } from "../builder/builder-write-response";
import { WorkflowDocument } from "../workflow-canvas/workflow-document";
import { composeLog } from "../workflow-canvas/messages";
const facts = { editRevision: "new", lastChangedAt: "2026-10-02T14:00:00Z", lastChangedBy: { name: "Ada Okafor", sqlName: "ada" } };
it("carries accepted child-write facts into the map head", () => {
  const map = { id: "m", layers: [{ id: "l", sql: "select 1" }], widgets: [] };
  expect(acceptedMapWrite(map as never, "/layers/l", "PATCH", { ...map.layers[0], ...facts })).toMatchObject(facts);
});
it("carries step and layout attribution into the workflow head", () => {
  const document = new WorkflowDocument("w");
  document.install({ id: "w", editRevision: "initial", steps: [] } as never, { editRevision: "initial", steps: {}, sources: {}, notes: [], updatedAt: null });
  document.receive({ ...facts, step: { id: "a", parameters: {} } });
  expect(document.recipe).toMatchObject(facts);
  const layoutFacts = { ...facts, editRevision: "layout", lastChangedBy: null };
  document.receive({ layout: { ...document.layout, ...layoutFacts } });
  expect(document.recipe).toMatchObject(layoutFacts);
});
it("retains known and unknown initiators beside run starts and node details", () => {
  const run = { id: "r", recipeId: "w", kind: "single", outcome: null, cancelled: false, startedAt: facts.lastChangedAt, finishedAt: null, members: [], runner: facts.lastChangedBy };
  expect(composeLog([run as never])[0]).toMatchObject({ runner: facts.lastChangedBy });
  expect(composeLog([{ ...run, runner: null } as never])[0]).toMatchObject({ runner: null });
});

it("shows the recorded run initiator without an owner fallback", () => {
  const known = renderToStaticMarkup(createElement(RunInitiator, { actor: facts.lastChangedBy }));
  expect(known).toContain("Ada Okafor (ada)");
  expect(known).toContain(">Ada</span>");
  expect(renderToStaticMarkup(createElement(RunInitiator, { actor: null }))).toContain(">Unknown</span>");
});
