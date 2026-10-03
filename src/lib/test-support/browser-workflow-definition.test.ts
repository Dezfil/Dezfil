import { expect, it } from "vitest";
import { stepDefinitions } from "../../../e2e/workflow-definition";

it("layout-only edits preserve step definitions while advancing parent edit facts", () => {
  const step = { id: "sql", parameters: { sql: "SELECT 1" }, output: null };
  expect(stepDefinitions([{ ...step, editRevision: "4e9a8c1b", lastChangedAt: "2026-10-03T10:00:00.100Z" }]))
    .toEqual(stepDefinitions([{ ...step, editRevision: "a805e70c", lastChangedAt: "2026-10-03T10:00:00.000Z" }]));
  expect(stepDefinitions([{ ...step, parameters: { sql: "SELECT 2" } }])).not.toEqual(stepDefinitions([step]));
});
