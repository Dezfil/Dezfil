import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { addStep, createRecipe, deleteRecipe } from "@/lib/metadata/recipes";
import { getCascade } from "@/lib/metadata/cascades";
import { getJob, isTerminal, listJobs } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { cascadeSettled, startCascade, startSingleRun } from "./cascade";
import { cancelRun } from "./run";
import { isExecuting, laneSettled, resetLane } from "./lane";

const scratch = process.env.DEZFIL_DATA_DIR!;
const expensive = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";
let directory: string, runs: string[];
beforeEach(() => {
  directory = mkdtempSync(path.join(scratch, "cascade-deletion-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "1");
  closeMetadataDb(); resetQueryInstance(); resetLane(); runs = [];
});
afterEach(async () => {
  const scope = testAccountScope();
  for (const job of listJobs()) if (!isTerminal(job.state)) await cancelRun(scope, job.id);
  await laneSettled(); await Promise.all(runs.map(cascadeSettled));
  resetLane(); closeMetadataDb(); resetQueryInstance(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it.each(["single", "all"] as const)("quietly drains a deleted workflow's %s run, including admitted work", async mode => {
  const scope = testAccountScope(), recipe = createRecipe(scope, "Removed while running");
  const first = addStep(recipe.id, { operation: "sql_step", parameters: { sql: expensive, name: "slow_output" } });
  if (mode === "all") addStep(recipe.id, { operation: "sql_step", parameters: { sql: expensive, name: "queued_output" } });
  const errors = vi.spyOn(console, "error"), warnings = vi.spyOn(console, "warn");
  const expectedRevision = readDocumentRevision({ kind: "workflow", id: recipe.id })!.editRevision;
  const run = mode === "single" ? await startSingleRun(scope, recipe.id, first.id, { expectedRevision })
    : await startCascade(scope, { recipeId: recipe.id, expectedRevision });
  runs.push(run.id);
  await vi.waitFor(() => expect(getCascade(run.id)!.members.every(member => member.state === "running" && member.jobId)).toBe(true));
  const jobs = getCascade(run.id)!.members.map(member => member.jobId!);
  expect(jobs).toHaveLength(mode === "single" ? 1 : 2);
  expect(getJob(jobs[0])?.state).toBe("running");
  expect(isExecuting(jobs[0])).toBe(true);
  if (mode === "all") expect(getJob(jobs[1])?.state).toBe("queued");
  expect(deleteRecipe(recipe.id)).toBe(true);
  expect(getCascade(run.id)).toBeNull();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ended = await Promise.race([cascadeSettled(run.id).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    expect({ ended, states: jobs.map(id => getJob(id)?.state), executing: jobs.some(isExecuting) })
      .toEqual({ ended: true, states: jobs.map(() => "cancelled"), executing: false });
  } finally { clearTimeout(timer); }
  expect(errors).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
  expect(getCascade(run.id)).toBeNull();
  expect(getTableByName("slow_output")).toBeNull(); expect(getTableByName("queued_output")).toBeNull();
});

it("drains a job admitted while workflow deletion wins the driver's await", async () => {
  const scope = testAccountScope(), recipe = createRecipe(scope, "Removed during admission");
  addStep(recipe.id, { operation: "sql_step", parameters: { sql: expensive, name: "slow_output" } });
  const execution = await import("./step-execution"), original = execution.startStepRun;
  let entered!: (id: string) => void, release!: () => void;
  const admitted = new Promise<string>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(execution, "startStepRun").mockImplementation(async (...args) => {
    const job = await original(...args); entered(job.id); await held; return job;
  });
  const errors = vi.spyOn(console, "error"), warnings = vi.spyOn(console, "warn");
  try {
    const run = await startCascade(scope, { recipeId: recipe.id,
      expectedRevision: readDocumentRevision({ kind: "workflow", id: recipe.id })!.editRevision });
    runs.push(run.id);
    const jobId = await admitted;
    expect(getJob(jobId)?.state).toBe("running");
    expect(deleteRecipe(recipe.id)).toBe(true);
    release(); await cascadeSettled(run.id);
    expect(getJob(jobId)?.state).toBe("cancelled");
    expect(isExecuting(jobId)).toBe(false);
    expect(errors).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
    expect(getCascade(run.id)).toBeNull(); expect(getTableByName("slow_output")).toBeNull();
  } finally { release(); }
});

it("waits for admitted work to release its slot even when its job is already terminal", async () => {
  const scope = testAccountScope(), recipe = createRecipe(scope, "Removed during cleanup");
  const first = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "slow_output" } });
  const materialization = await import("./materialize"), original = materialization.materialize;
  const jobs = await import("@/lib/metadata/jobs");
  let entered!: () => void, release!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(materialization, "materialize").mockImplementation(async (...args) => {
    signal = args[1].signal; entered(); await held; return original(...args);
  });
  try {
    const run = await startSingleRun(scope, recipe.id, first.id, {
      expectedRevision: readDocumentRevision({ kind: "workflow", id: recipe.id })!.editRevision });
    runs.push(run.id); await started;
    const job = getCascade(run.id)!.members[0].jobId!;
    expect(isExecuting(job)).toBe(true);
    jobs.finish(job, { state: "cancelled" }, new Date().toISOString());
    deleteRecipe(recipe.id);
    let ended = false;
    const settled = cascadeSettled(run.id).then(() => { ended = true; });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 5000 });
    expect(ended).toBe(false);
    release(); await settled;
    expect(isExecuting(job)).toBe(false);
    expect(getCascade(run.id)).toBeNull(); expect(getTableByName("slow_output")).toBeNull();
  } finally { release(); }
});
