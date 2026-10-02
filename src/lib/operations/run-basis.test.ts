import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { editStep, renameRecipe } from "@/lib/metadata/owned-recipes";
import { createCascade } from "@/lib/metadata/owned-cascades";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { startStepRun } from "./step-execution";

const hooks = vi.hoisted(() => ({ admit: vi.fn(), submit: vi.fn() }));
vi.mock("./run", () => ({ admitOwned: hooks.admit, submitRun: hooks.submit }));
let db: Database, dir: string, id: string, stepId: string, runId: string;
const scope = () => testAccountScope(db, "runner");
const facts = () => readDocumentRevision({ kind: "workflow", id }, db)!;
const edit = () => editStep(scope(), stepId, { sql: "SELECT 2", name: "out" }, db, undefined, { expectedRevision: facts().editRevision });
const basis = () => db.prepare("SELECT admitted_executable_revision AS basis FROM cascade_runs WHERE id = ?").get(runId);
beforeEach(() => {
  dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "basis-"));
  db = metadata.open(path.join(dir, "metadata.sqlite"));
  vi.spyOn(metadata, "metadataDb").mockImplementation(() => db);
  hooks.admit.mockReset().mockResolvedValue({ operationId: "sql_step", sql: "SELECT 1", name: "out" });
  hooks.submit.mockReset().mockReturnValue({ id: "job" });
  id = createRecipe(scope(), "Workflow", db).id;
  stepId = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "out" } }, db).id;
  runId = createCascade(scope(), id, "run_all", [{ stepId, ordinal: 0 }], db).id;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it("persists the executable basis with the run across reopen, without changing the document", () => {
  const before = facts();
  expect(basis()).toEqual({ basis: before.executableRevision });
  db.close(); db = metadata.open(path.join(dir, "metadata.sqlite"));
  expect(basis()).toEqual({ basis: before.executableRevision });
  expect(facts()).toEqual(before);
});

it("refuses an executable change before compiling the next member", async () => {
  edit();
  await expect(startStepRun(scope(), stepId, { cascadeId: runId })).rejects.toMatchObject({ code: "plan_changed", status: 409 });
  expect(hooks.admit).not.toHaveBeenCalled();
  expect(hooks.submit).not.toHaveBeenCalled();
});

it("checks the durable basis again after asynchronous compilation and before minting a job", async () => {
  hooks.admit.mockImplementationOnce(async () => { edit(); return { operationId: "sql_step", sql: "SELECT 1", name: "out" }; });
  await expect(startStepRun(scope(), stepId, { cascadeId: runId })).rejects.toMatchObject({ code: "plan_changed", status: 409 });
  expect(hooks.admit).toHaveBeenCalledTimes(1);
  expect(hooks.submit).not.toHaveBeenCalled();
});

it("admits against the executable basis after a rename advances the edit revision", async () => {
  const before = facts();
  renameRecipe(scope(), id, "Renamed", db, { expectedRevision: before.editRevision });
  expect(facts().editRevision).not.toBe(before.editRevision);
  await expect(startStepRun(scope(), stepId, { cascadeId: runId })).resolves.toEqual({ id: "job" });
  expect(hooks.submit).toHaveBeenCalledTimes(1);
  expect(basis()).toEqual({ basis: before.executableRevision });
});
