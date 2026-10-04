import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LastChanged } from "./LastChanged";
import { RunInitiator } from "./RunInitiator";
import { historyControl } from "../builder/shared-history";

it.each([null, { name: "Ada Person", sqlName: "ada_person" }, { deleted: true }])("safely renders the actor %j on facts, runs and both history controls", actor => {
  const expected = actor === null ? "Unknown" : "deleted" in actor ? "Deleted account" : "Ada";
  const fact = renderToStaticMarkup(<LastChanged value={{ lastChangedAt: "2026-01-01", lastChangedBy: actor as never }} />);
  const run = renderToStaticMarkup(<RunInitiator actor={actor as never} />);
  expect(fact).toContain(expected); expect(run).toContain(expected);
  const target = { eligible: true, reason: null, steps: [{ id: "h", scope: "map", targetId: "m", op: "update", author: actor, createdAt: "t" }] };
  for (const direction of ["undo", "redo"] as const) {
    expect(historyControl({ canUndo: true, canRedo: true, undoTarget: target, redoTarget: target } as never, direction).action).toContain(expected);
  }
  if (actor && "deleted" in actor) {
    expect(fact).not.toContain("Unknown"); expect(run).not.toContain("title=");
    expect(fact + run).not.toMatch(/undefined|sqlName|ada_person/);
    expect(fact).toContain('data-deleted="true"'); expect(fact).not.toContain("data-unknown");
  }
});
