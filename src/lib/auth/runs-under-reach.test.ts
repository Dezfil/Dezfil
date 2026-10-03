import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import { recordOutput, runnerOutput } from "@/lib/metadata/recipe-outputs";
import { getJob } from "@/lib/metadata/jobs";
import { cancelCascade, cascadeSettled, readCascade, startCascade, startSingleRun } from "@/lib/operations/cascade";
import { isExecuting, laneSettled, resetLane } from "@/lib/operations/lane";
import { planPublication } from "@/lib/operations/step-run";
import { recoverInterruptedCascades, recoverInterruptedRuns } from "@/lib/operations/recover";
import { executeQuery } from "@/lib/query/execute";
import { mapEvaluation } from "@/lib/query/context";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { CascadeRun } from "@/lib/metadata/cascades";
import type { AccountScope } from "./scope";

/**
 * A workflow run by the people it is shared with. Pat owns project P; Ada, an
 * editor of P, owns workflow W filed in P and her `roads`, filed there too;
 * Bo is another editor, Vi a viewer, Cy belongs to nothing. W stages Ada's
 * roads with a token unique to each run, then counts what it staged.
 *
 * A run is its runner's: it reads in W's home within the runner's reach,
 * creates the runner's own datasets, files them into W's project at commit
 * when the runner may file there, and records them against the runner, so
 * one runner never replaces or reads another's output and Ada's map keeps
 * drawing Ada's.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let roads: string;
let recipe: string;
let staged: string;
let tally: string;

const ENDLESS = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "runs-under-reach-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["pat", "ada", "bo", "vi", "cy"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "sentinel,lon,lat\nada roads,1,2\n");
  roads = (await ingestFile(scopes.ada, file, "roads.csv")).id;
  shareProject("pat", "P", [["ada", "editor"], ["bo", "editor"], ["vi", "viewer"]], [roads]);
  recipe = createRecipe(scopes.ada, "Survey").id;
  fileRecipe(recipe, "P");
  staged = addStep(recipe, { operation: "sql_step", parameters: {
    sql: "SELECT sentinel, gen_random_uuid()::VARCHAR AS token FROM roads", name: "staged" } }).id;
  tally = addStep(recipe, { operation: "sql_step", parameters: { sql: "SELECT count(*) AS n, min(token) AS token FROM staged", name: "tally" } }).id;
});
afterEach(async () => {
  await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const db = () => metadataDb();
type Row = { id: string; owner_id: string; file: string };
const datasets = (name: string) => db().prepare("SELECT id, owner_id, file FROM data_tables WHERE name = ? ORDER BY owner_id").all(name) as Row[];
const owned = (owner: string, name: string) => datasets(name).find((row) => row.owner_id === owner);
const filedIn = (id: string) => (db().prepare("SELECT project_id FROM project_datasets WHERE table_id = ?").all(id) as { project_id: string }[]).map((r) => r.project_id);
const token = async (scope: AccountScope, sql: string) => String((await executeQuery(scope, sql)).preview[0].token);
const member = (run: CascadeRun, stepId: string) => run.members.find((m) => m.stepId === stepId)!;

async function runAll(account: string) {
  const run = await startCascade(scopes[account], { expectedRevision: readEditRevision({ kind: "workflow", id: recipe })?.editRevision, recipeId: recipe });
  await cascadeSettled(run.id); await laneSettled();
  return readCascade(scopes[account], run.id);
}

describe("runs under reach", () => {
  it("gives every runner their own outputs, filed in the project, and leaves the others' alone", async () => {
    const first = await runAll("ada");
    expect(first.outcome).toBe("completed");
    const ada = { staged: owned("ada", "staged")!, tally: owned("ada", "tally")! };
    const adaToken = await token(scopes.ada, "SELECT token FROM staged");

    const second = await runAll("bo");
    expect(second.outcome, JSON.stringify(second.members)).toBe("completed");
    const bo = { staged: owned("bo", "staged")!, tally: owned("bo", "tally")! };
    expect(bo.staged.id).not.toBe(ada.staged.id);
    // Bo's outputs are Bo's own, filed in the workflow's project.
    expect(filedIn(bo.staged.id)).toEqual(["P"]);
    expect(filedIn(bo.tally.id)).toEqual(["P"]);
    // Ada's outputs are exactly as she left them.
    expect(owned("ada", "staged")).toEqual(ada.staged);
    expect(owned("ada", "tally")).toEqual(ada.tally);
    // The lookup by step and runner, one row each.
    expect(runnerOutput(staged, "ada")).toMatchObject({ id: ada.staged.id, name: "staged" });
    expect(runnerOutput(staged, "bo")).toMatchObject({ id: bo.staged.id, name: "staged", runId: second.id });
    // Bo's count read Bo's staging, never Ada's.
    const boToken = await token(scopes.bo, "SELECT token FROM staged");
    expect(boToken).not.toBe(adaToken);
    expect(await token(scopes.bo, "SELECT token FROM tally")).toBe(boToken);
    const edges = db().prepare("SELECT input_table_id, runner_id FROM lineage_edges WHERE step_id = ? ORDER BY runner_id").all(tally);
    expect(edges).toEqual([{ input_table_id: ada.staged.id, runner_id: "ada" }, { input_table_id: bo.staged.id, runner_id: "bo" }]);

    // Ada's map still draws Ada's output, for Ada and for Bo alike.
    const map = createMap(scopes.ada, "Survey map");
    for (const reader of ["ada", "bo"]) {
      expect(await token(mapEvaluation(scopes[reader], map.id) as AccountScope, "SELECT token FROM staged")).toBe(adaToken);
    }

    // The project's owner, acting as an editor, runs it too: Pat's own.
    expect((await runAll("pat")).outcome).toBe("completed");
    expect(filedIn(owned("pat", "staged")!.id)).toEqual(["P"]);

    // A rerun replaces only the same runner's output, in place.
    expect((await runAll("bo")).outcome).toBe("completed");
    const rerun = owned("bo", "staged")!;
    expect(rerun.id).toBe(bo.staged.id);
    expect(rerun.file).not.toBe(bo.staged.file);
    expect(await token(scopes.bo, "SELECT token FROM staged")).not.toBe(boToken);
    expect(owned("ada", "staged")).toEqual(ada.staged);
    expect((await runAll("ada")).outcome).toBe("completed");
    expect(owned("ada", "staged")!.id).toBe(ada.staged.id);
    expect(owned("bo", "staged")).toEqual(rerun);
  }, 120_000);

  it("refuses an unrelated dataset already holding the name in the runner's own space", async () => {
    const file = path.join(directory, "mine.csv");
    await writeFile(file, "sentinel,lon,lat\nbo's own,1,2\n");
    const mine = await ingestFile(scopes.bo, file, "staged.csv");
    expect(mine.name).toBe("staged");
    const run = await runAll("bo");
    expect(member(run, staged)).toMatchObject({ state: "failed", stoppedBy: "name_taken", jobId: null });
    expect(member(run, tally)).toMatchObject({ state: "not_run" });
    expect(owned("bo", "staged")).toMatchObject({ id: mine.id, file: mine.file });
    expect(runnerOutput(staged, "bo")).toBeNull();
  }, 60_000);

  it("reads the same runner's latest output when a step runs alone, and fails by name when that runner has none", async () => {
    expect((await runAll("ada")).outcome).toBe("completed");
    // Bo has never staged: his count of `staged` fails by the diagnostic, and
    // neither Ada's staging nor anything else stands in.
    const missing = await startSingleRun(scopes.bo, recipe, tally, { expectedRevision: readEditRevision({ kind: "workflow", id: recipe })?.editRevision });
    await cascadeSettled(missing.id); await laneSettled();
    const failed = member(readCascade(scopes.bo, missing.id), tally);
    expect(failed).toMatchObject({ state: "failed", attempt: { state: "failed" } });
    expect(failed.attempt!.error!.message).toContain('"staged" is not available to you');
    expect(owned("bo", "tally")).toBeUndefined();
    const own = await startSingleRun(scopes.bo, recipe, staged, { expectedRevision: readEditRevision({ kind: "workflow", id: recipe })?.editRevision });
    await cascadeSettled(own.id); await laneSettled();
    const alone = await startSingleRun(scopes.bo, recipe, tally, { expectedRevision: readEditRevision({ kind: "workflow", id: recipe })?.editRevision });
    await cascadeSettled(alone.id); await laneSettled();
    expect(readCascade(scopes.bo, alone.id).outcome).toBe("completed");
    expect(await token(scopes.bo, "SELECT token FROM tally")).toBe(await token(scopes.bo, "SELECT token FROM staged"));
  }, 90_000);

  it("keeps the association through job retention", async () => {
    expect((await runAll("bo")).outcome).toBe("completed");
    const output = owned("bo", "staged")!;
    // Retention removes job rows; nothing about the association depends on them.
    db().prepare("DELETE FROM operation_jobs").run();
    expect(runnerOutput(staged, "bo")).toMatchObject({ id: output.id, name: "staged" });
    expect(planPublication(scopes.bo, staged).replaceTable).toEqual({ id: output.id, name: "staged" });
    expect((await runAll("bo")).outcome).toBe("completed");
    expect(owned("bo", "staged")!.id).toBe(output.id);
  }, 90_000);

  it("finds a completion recorded before the readers switched", async () => {
    expect((await runAll("ada")).outcome).toBe("completed");
    const output = owned("ada", "staged")!;
    // What the publication wrote from the migration on: both representations,
    // with the runner. Remove the run's own row and record it that way again.
    db().prepare("DELETE FROM step_runner_outputs WHERE step_id = ?").run(staged);
    recordOutput(staged, { id: output.id, name: "staged" }, new Date().toISOString(), db(), { accountId: "ada", jobId: null, runId: null });
    expect(runnerOutput(staged, "ada")).toMatchObject({ id: output.id, name: "staged" });
    expect(planPublication(scopes.ada, staged).replaceTable).toEqual({ id: output.id, name: "staged" });
    // Another runner's latest success moved the legacy association; the
    // lookup still answers each runner with their own.
    expect((await runAll("bo")).outcome).toBe("completed");
    expect(planPublication(scopes.ada, staged).replaceTable).toEqual({ id: output.id, name: "staged" });
    expect(planPublication(scopes.bo, staged).replaceTable).toEqual({ id: owned("bo", "staged")!.id, name: "staged" });
  }, 90_000);

  it("lets the workflow's owner cancel a run someone else started, interrupting it in the engine", async () => {
    db().prepare("UPDATE recipe_steps SET parameters = json_set(parameters, '$.sql', ?) WHERE id = ?").run(ENDLESS, staged);
    const run = await startCascade(scopes.bo, { expectedRevision: readEditRevision({ kind: "workflow", id: recipe })?.editRevision, recipeId: recipe });
    let jobId: string | null = null;
    for (let i = 0; i < 200 && !jobId; i += 1) {
      jobId = member(readCascade(scopes.bo, run.id), staged).jobId;
      if (!jobId) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(getJob(jobId!)?.state).toMatch(/queued|running/);
    const started = Date.now();
    const cancelled = await cancelCascade(scopes.ada, run.id);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(cancelled.outcome).toBe("cancelled");
    expect(getJob(jobId!)?.state ?? member(cancelled, staged).attempt?.state).toBe("cancelled");
    expect(isExecuting(jobId!)).toBe(false);
    expect(member(readCascade(scopes.ada, run.id), staged).attempt?.state).toBe("cancelled");
    expect(member(cancelled, tally).state).toBe("not_run");
  }, 60_000);

  it("settles a runner's run left in flight by a stopped process", async () => {
    expect((await runAll("bo")).outcome).toBe("completed");
    const output = owned("bo", "staged")!;
    // The store as a process that died mid-run left it: Bo's run with its
    // first member published and its second running.
    const now = new Date().toISOString();
    db().prepare(`INSERT INTO cascade_runs (id, recipe_id, kind, started_at, initiator_id) VALUES ('C', ?, 'run_all', ?, 'bo')`).run(recipe, now);
    db().prepare(`INSERT INTO cascade_members (cascade_id, step_id, ordinal, state, job_id, output_table_id, output_table_name)
      VALUES ('C', ?, 0, 'succeeded', NULL, ?, 'staged'), ('C', ?, 1, 'running', 'J', NULL, NULL)`).run(staged, output.id, tally);
    db().prepare(`INSERT INTO operation_jobs (owner_id, id, subject_kind, subject_id, operation, parameters, state, accepted_at, started_at)
      VALUES ('bo', 'J', 'step', ?, 'sql_step', '{}', 'running', ?, ?)`).run(tally, now, now);
    expect(recoverInterruptedRuns()).toBe(1);
    expect(recoverInterruptedCascades()).toBe(1);
    const recovered = readCascade(scopes.bo, "C");
    expect(recovered.outcome).toBe("interrupted");
    expect(member(recovered, tally)).toMatchObject({ state: "failed", stoppedBy: "operation_interrupted" });
    expect(member(recovered, tally).attempt).toMatchObject({ state: "failed", error: { code: "operation_interrupted" } });
    expect(runnerOutput(staged, "bo")).toMatchObject({ id: output.id });
  }, 60_000);

  it("completes unfiled when the workflow's owner may no longer file into its project", async () => {
    db().prepare("UPDATE project_people SET role = 'viewer' WHERE account_id = 'ada'").run();
    const viewer = await runAll("ada");
    expect(viewer.outcome, JSON.stringify(viewer.members)).toBe("completed");
    expect(filedIn(owned("ada", "staged")!.id)).toEqual([]);
    db().prepare("DELETE FROM project_people WHERE account_id = 'ada'").run();
    db().prepare("DELETE FROM data_tables WHERE owner_id = 'ada' AND name IN ('staged', 'tally')").run();
    db().prepare("DELETE FROM step_runner_outputs").run();
    db().prepare("UPDATE recipe_steps SET output_table_id = NULL, output_table_name = NULL").run();
    const outsider = await runAll("ada");
    expect(outsider.outcome, JSON.stringify(outsider.members)).toBe("completed");
    expect(filedIn(owned("ada", "staged")!.id)).toEqual([]);
  }, 90_000);
});
