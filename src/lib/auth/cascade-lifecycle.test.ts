import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { readHold } from "@/lib/test-support/read-hold";
import type { AccountScope } from "./scope";
import { submitRun } from "@/lib/operations/run";
import { laneDepth, laneSettled, resetLane } from "@/lib/operations/lane";
import { getJob, listJobs } from "@/lib/metadata/jobs";
import { getOwnedTableByName, listOwnedTables } from "@/lib/metadata/owned-tables";
import { resetQueryInstance } from "@/lib/duckdb";
import { inspectTable } from "@/lib/table-service";
import { recoverInterruptedRuns, recoverInterruptedCascades } from "@/lib/operations/recover";
const measure = vi.hoisted(() => ({ after: undefined as undefined | (() => void) }));
vi.mock("@/lib/ingest/ingest", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/ingest/ingest")>();
  return { ...actual, measureArtifact: async (...args: Parameters<typeof actual.measureArtifact>) => { const value = await actual.measureArtifact(...args); measure.after?.(); return value; } };
});
let dir: string, prior: string | undefined, scopes: Record<string, AccountScope>;
const accounts = ["alice", "bob", "admin"];
beforeEach(async () => {
  prior = process.env.DEZFIL_DATA_DIR; dir = await mkdtemp(path.join(process.cwd(), ".claude/job-life-"));
  process.env.DEZFIL_DATA_DIR = dir; closeMetadataDb(); resetQueryInstance(); resetLane(); measure.after = undefined;
  scopes = Object.fromEntries(accounts.map(account => [account, testAccountScope(metadataDb(), account)]));
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(async () => {
  measure.after = undefined; await laneSettled(); resetLane(); resetQueryInstance(); closeMetadataDb();
  if (prior === undefined) delete process.env.DEZFIL_DATA_DIR; else process.env.DEZFIL_DATA_DIR = prior;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY; delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
  await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});

import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { createCascade, getCascade, setMember } from "@/lib/metadata/cascades";
import { startCascade, startSingleRun, cascadeSettled, cancelCascade } from "@/lib/operations/cascade";
function workflow(account: string, name = "same_output", value = 1) {
  const recipe = createRecipe(scopes[account], "Private workflow");
  const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: `SELECT ${value} AS value`, name } }); return { recipe, step };
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function files() { try { return await readdir(path.join(dir, "tables")); } catch { return []; } }
it("completes and replaces same-named outputs independently for all workflow owners", async () => {
  const outputs = new Set<string>();
  for (const [n, account] of accounts.entries()) {
    const { recipe, step } = workflow(account, "same_output", n);
    const run = await startSingleRun(scopes[account], recipe.id, step.id); await cascadeSettled(run.id);
    expect(getCascade(run.id)?.outcome).toBe("completed"); const output = getOwnedTableByName(scopes[account], "same_output")!; expect(output).not.toBeNull(); outputs.add(output.id);
    const again = await startSingleRun(scopes[account], recipe.id, step.id); await cascadeSettled(again.id);
    expect(getCascade(again.id)?.outcome).toBe("completed"); expect(getOwnedTableByName(scopes[account], "same_output")?.id).toBe(output.id);
    expect((await inspectTable(scopes[account], "same_output")).preview).toEqual([{ value: n }]);
  }
  expect(outputs.size).toBe(3);
});
it("drains a deactivated cascade and preserves only outputs committed before deactivation", async () => {
  process.env.DEZFIL_OPERATION_CONCURRENCY = "1";
  const { recipe } = workflow("alice", "first");
  addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 2 AS value", name: "second" } });
  addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 3 AS value FROM second", name: "dependent" } });
  let artifacts = 0; measure.after = () => { if (++artifacts === 2) metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); };
  const run = await startCascade(scopes.alice, { recipeId: recipe.id }); await cascadeSettled(run.id); await laneSettled();
  const done = getCascade(run.id)!; expect(done.outcome).toBe("partly_completed"); expect(done.members.map(m => m.state)).toEqual(["succeeded", "failed", "not_run"]);
  expect(done.members[1].attempt).toMatchObject({ state: "failed", error: { code: "authentication_required" } });
  expect(done.members[2].stoppedBy).toBe("authentication_required"); expect(done.members[2].jobId).toBeNull();
  expect(await files()).toHaveLength(1); expect(listJobs().every(j => ["succeeded", "failed"].includes(j.state))).toBe(true);
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run(); expect(listOwnedTables(scopes.alice).map(t => t.name)).toEqual(["first"]);
});
it("recovers inactive workflows without attaching another owner's job attempt", () => {
  const alice = workflow("alice"), bob = workflow("bob");
  const other = submitRun(scopes.bob, { operationId: "sql_step", parameters: {}, sql: "SELECT 1", name: "other" });
  const run = createCascade(alice.recipe.id, "single", [{ stepId: alice.step.id, ordinal: 0 }]);
  setMember(run.id, alice.step.id, { state: "running", jobId: other.id });
  const own = createCascade(bob.recipe.id, "single", [{ stepId: bob.step.id, ordinal: 0 }]);
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  recoverInterruptedRuns(); expect(recoverInterruptedCascades()).toBe(2);
  expect(getCascade(run.id)?.members[0].attempt).toBeNull(); expect(getCascade(own.id)?.outcome).toBe("interrupted"); expect(recoverInterruptedCascades()).toBe(0);
});
it("withholds a cancellation answer when the owner is deactivated during the drain", async () => {
  const { recipe, step } = workflow("alice"); const gate = deferred();
  const blocker = submitRun(scopes.bob, { operationId: "sql_step", name: "blocker", parameters: {}, sql: "", prepare: async () => { await gate.promise; return { sql: "SELECT 1", disclosure: {}, cleanup: async () => {} }; } });
  const run = await startSingleRun(scopes.alice, recipe.id, step.id);
  const cancelling = cancelCascade(scopes.alice, run.id); const refused = expect(cancelling).rejects.toMatchObject({ code: "authentication_required" });
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); gate.release(); await refused; await cascadeSettled(run.id); await laneSettled();
  expect(getCascade(run.id)?.outcome).toBe("cancelled"); expect(getJob(blocker.id)?.state).toBe("succeeded");
});
it("keeps a deactivated attempt after depth-one history prunes its job", async () => {
  process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "1";
  const { recipe, step } = workflow("alice");
  const first = await startSingleRun(scopes.alice, recipe.id, step.id); await cascadeSettled(first.id);
  const original = getOwnedTableByName(scopes.alice, "same_output")!;
  measure.after = () => metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  const second = await startSingleRun(scopes.alice, recipe.id, step.id); await cascadeSettled(second.id);
  const member = getCascade(second.id)!.members[0];
  expect(getJob(member.jobId!)).toBeNull(); expect(member.attempt).toMatchObject({ state: "failed", error: { code: "authentication_required" } });
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run(); expect(getOwnedTableByName(scopes.alice, "same_output")?.file).toBe(original.file);
});
it("keeps result identity private after both its step and output are deleted", async () => {
  const { recipe, step } = workflow("alice");
  const run = await startSingleRun(scopes.alice, recipe.id, step.id); await cascadeSettled(run.id);
  const { readCascade } = await import("@/lib/operations/cascade"), before = readCascade(scopes.alice, run.id);
  const { removeTable } = await import("@/lib/table-service"); const { removeStep } = await import("@/lib/metadata/owned-recipes");
  await removeTable(scopes.alice, "same_output"); removeStep(scopes.alice, step.id);
  expect(readCascade(scopes.alice, run.id)).toEqual(before);
  for (const account of ["bob", "admin"]) {
    expect(() => readCascade(scopes[account], run.id)).toThrow(expect.objectContaining({ status: 404 }));
    await expect(cancelCascade(scopes[account], run.id)).rejects.toMatchObject({ status: 404 });
  }
  expect(getOwnedTableByName(scopes.alice, "same_output")).toBeNull();
});
it("drains a single admitted job when its workflow disappears before the member is recorded", async () => {
  const { recipe, step } = workflow("alice"), gate = deferred();
  const admission = readHold("single-run admission"), cancellation = readHold("orphaned job cancellation");
  const runApi = await import("@/lib/operations/run"), execution = await import("@/lib/operations/step-execution");
  const { deleteRecipe } = await import("@/lib/metadata/owned-recipes");
  const submit = runApi.submitRun, start = execution.startStepRun, wait = runApi.waitForRunCancellation;
  let jobId = "", cascadeId = "";
  vi.spyOn(runApi, "submitRun").mockImplementation((scope, options) => {
    const job = submit(scope, { ...options, prepare: async () => { await gate.promise; return { sql: "SELECT 1 AS value", disclosure: {}, cleanup: async () => {} }; } }); jobId = job.id; return job;
  });
  vi.spyOn(execution, "startStepRun").mockImplementation(async (...args) => {
    const job = await start(...args); cascadeId = args[2]!.cascadeId!;
    await admission.engage(); return job;
  });
  vi.spyOn(runApi, "waitForRunCancellation").mockImplementation(async (...args) => {
    await cancellation.engage(); return wait(...args);
  });
  const started = startSingleRun(scopes.alice, recipe.id, step.id); const refused = expect(started).rejects.toMatchObject({ status: 404 });
  try {
    await admission.beforeMutation();
    expect(getJob(jobId)?.state).toBe("running");
    expect(getCascade(cascadeId)?.members[0]).toMatchObject({ state: "pending", jobId: null });
    deleteRecipe(scopes.alice, recipe.id); admission.release();
    await cancellation.beforeMutation();
    // The cancellation is durable while preparation still holds the lane.
    expect(getJob(jobId)?.state).toBe("cancelled");
    expect(laneDepth()).toEqual({ executing: 1, waiting: 0 });
  } finally {
    admission.release(); cancellation.release(); gate.release();
    await refused; await laneSettled();
  }
  expect(getJob(jobId)?.state).toBe("cancelled");
  expect(laneDepth()).toEqual({ executing: 0, waiting: 0 });
  expect(listOwnedTables(scopes.alice)).toEqual([]);
  expect(await files()).toEqual([]);
});
