import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createRecipe, addStep, getStep, recordOutput } from "@/lib/metadata/recipes";
import { editStep, renameRecipe } from "@/lib/metadata/owned-recipes";
import { createCascade } from "@/lib/metadata/owned-cascades";
import { cascadeMatchesExecutable, getCascade } from "@/lib/metadata/cascades";
import * as cascades from "@/lib/metadata/cascades";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { planPublication, stepAuthorizer, type StepPublication } from "./step-run";
import { requireRunBasis } from "./run-basis";

let db: Database, dir: string, id: string, first: string, second: string, runId: string;
const scope = () => testAccountScope(db, "runner");
const facts = () => readDocumentRevision({ kind: "workflow", id }, db)!;
const edit = (stepId: string, n: number) => editStep(scope(), stepId, { sql: `SELECT ${n}`, name: stepId === first ? "first" : "second" }, db, undefined, { expectedRevision: facts().editRevision });
const publish = (plan: StepPublication, finish = () => true) => stepAuthorizer(scope(), plan, finish, runId)({ id: `output-${plan.step.id}`, name: String(plan.running.name) }, db, []);
beforeEach(() => {
  dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "promotion-"));
  db = metadata.open(path.join(dir, "metadata.sqlite"));
  vi.spyOn(metadata, "metadataDb").mockImplementation(() => db);
  id = createRecipe(scope(), "Workflow", db).id;
  first = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "first" } }, db).id;
  second = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "second" } }, db).id;
  for (const stepId of [first, second]) recordOutput(stepId, { id: `old-${stepId}`, name: stepId === first ? "first" : "second" }, "2026-01-01", db);
  edit(first, 2); edit(second, 2);
  runId = createCascade(scope(), id, "run_all", [{ stepId: first, ordinal: 0 }, { stepId: second, ordinal: 1 }], db).id;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it("advances only its own run basis with promotion and admits the remaining member", () => {
  const otherRun = createCascade(scope(), id, "single", [{ stepId: second, ordinal: 0 }], db).id;
  const before = facts();
  const firstPlan = planPublication(scope(), first), secondPlan = planPublication(scope(), second);
  expect(publish(firstPlan)).toBe(true);
  expect(facts().editRevision).not.toBe(before.editRevision);
  expect(facts().executableRevision).not.toBe(before.executableRevision);
  expect(facts().lastChangedBy).toBe(scope().accountId);
  expect(cascadeMatchesExecutable(runId, id, db)).toBe(true);
  expect(cascadeMatchesExecutable(otherRun, id, db)).toBe(false);
  expect(() => requireRunBasis(id, before.executableRevision!, runId, db)).not.toThrow();
  // Already admitted siblings hold the older token too: their own run's
  // durable advancement, not that captured token, decides promotion.
  expect(publish(secondPlan)).toBe(true);
  expect(getStep(second, db)!.proposedParameters).toBeNull();
  expect(cascadeMatchesExecutable(runId, id, db)).toBe(true);
});

it("refuses promotion after a foreign definition edit without recording output or success", () => {
  const plan = planPublication(scope(), first);
  edit(second, 3);
  const before = facts(), step = getStep(first, db), run = getCascade(runId, db);
  const finish = vi.fn(() => true);
  expect(publish(plan, finish)).toBe(false);
  expect(finish).not.toHaveBeenCalled();
  expect(getStep(first, db)).toEqual(step);
  expect(getCascade(runId, db)).toEqual(run);
  expect(facts()).toEqual(before);
});

it("preserves a concurrent rename while attributing promotion to the runner", () => {
  const plan = planPublication(scope(), first);
  renameRecipe(scope(), id, "Accepted rename", db, { expectedRevision: facts().editRevision });
  expect(publish(plan)).toBe(true);
  expect(db.prepare("SELECT name FROM recipes WHERE id = ?").get(id)).toEqual({ name: "Accepted rename" });
  expect(cascadeMatchesExecutable(runId, id, db)).toBe(true);
});

it("rolls promotion, revisions, run basis and success back with a failed publication transaction", () => {
  const plan = planPublication(scope(), first), before = facts(), step = getStep(first, db), run = getCascade(runId, db);
  vi.spyOn(cascades, "advanceCascadeExecutable").mockImplementationOnce(() => { throw new Error("publication failed"); });
  expect(() => publish(plan)).toThrow("publication failed");
  expect(getStep(first, db)).toEqual(step);
  expect(getCascade(runId, db)).toEqual(run);
  expect(facts()).toEqual(before);
  expect(cascadeMatchesExecutable(runId, id, db)).toBe(true);
});
