import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { retirementsSettled } from "@/lib/ingest/retire";
import { removeTable } from "@/lib/table-service";
import { getJob, listJobs } from "@/lib/metadata/jobs";
import { edgesForStep } from "@/lib/metadata/lineage";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import { executeQuery } from "@/lib/query/execute";
import { startStepRun } from "./step-execution";
import { readRecipe, readStep } from "./recipe-view";
import { laneSettled, resetLane } from "./lane";
import { cascadeSettled, readCascade, startCascade } from "./cascade";

const holding = vi.hoisted(() => ({
  registered: undefined as undefined | (() => Promise<void>),
  stepId: "",
}));

// Outside the real serialized registration turn, but before the materializer
// reads its registry snapshot. Admission has no running job, so cannot take
// this hold. Forward every argument, including the repair's snapshot handoff.
vi.mock("@/lib/query/views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/views")>();
  return {
    ...actual,
    registerTableViews: async (...args: Parameters<typeof actual.registerTableViews>) => {
      await actual.registerTableViews(...args);
      const hold = holding.registered;
      if (hold && listJobs({ subjectId: holding.stepId }).some((j) => j.state === "running")) {
        holding.registered = undefined;
        await hold();
      }
    },
  };
});

let dir: string;
let server: Server;
let url: string;
let recipeId: string;
let source: DataTable;
let value: number;
let releaseHold: (() => void) | undefined;
const SQL = "SELECT CAST(value AS INTEGER) AS value FROM lineage_source";

beforeEach(async () => {
  resetLane();
  resetRefreshFences();
  holding.registered = undefined;
  holding.stepId = "";
  value = 1;
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-lineage-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  resetQueryInstance();
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/csv" });
    res.end(`value\n${value}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/source.csv`;
  await importFromUrl(testAccountScope(), url, "lineage_source");
  source = getTableByName("lineage_source")!;
  expect((await executeQuery(SQL)).preview).toEqual([{ value: 1 }]);
  recipeId = createRecipe(testAccountScope(), "Pinned lineage").id;
});

afterEach(async () => {
  releaseHold?.();
  releaseHold = undefined;
  holding.registered = undefined;
  await laneSettled();
  await retirementsSettled();
  vi.restoreAllMocks();
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY;
  await rm(dir, { recursive: true, force: true });
});

function step(name = "lineage_output", sql = SQL) {
  return addStep(recipeId, { operation: "sql_step", parameters: { sql, name } });
}

/** A handshake, never a timing guess; cleanup releases even a failed test. */
function holdAt(point: "copied" | "registered" | "pre-copy", stepId: string) {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  releaseHold = release;
  const hold = async () => { reached(); await released; };
  if (point === "registered") {
    holding.stepId = stepId;
    holding.registered = hold;
  } else {
    const run = DuckDBConnection.prototype.run;
    let used = false;
    vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
      const match = !used && sql.startsWith(`COPY (${SQL})`);
      if (match) used = true;
      if (match && point === "pre-copy") await hold();
      const result = await run.call(this, sql, ...args);
      if (match && point === "copied") await hold();
      return result;
    });
  }
  return {
    release,
    async reached() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reachedPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${point} hold never reached`)), 10_000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

async function readArtifact(table: DataTable) {
  return withConnection(async (conn) => {
    const file = path.join(dir, "data", table.file).replace(/'/g, "''");
    return (await conn.runAndReadAll(`SELECT CAST(value AS INTEGER) AS value FROM read_parquet('${file}')`)).getRowObjectsJson();
  });
}

async function refresh() {
  value = 2;
  await refreshTable(testAccountScope(), source.name);
  const next = getTableByName(source.name)!;
  expect(next.id).toBe(source.id);
  expect(next.file).not.toBe(source.file);
  expect(await readArtifact(next)).toEqual([{ value: 2 }]);
  // Retirement has been scheduled by the real refresh, yet our held reader
  // still owns this artifact. Read it as well as checking that it exists.
  expect((await stat(path.join(dir, "data", source.file))).size).toBeGreaterThan(0);
  expect(await readArtifact(source)).toEqual([{ value: 1 }]);
  return next;
}

async function assertPublished(stepId: string, input: DataTable, expectedValue: number,
  condition: "stale" | "current" | "broken", name = "lineage_output") {
  const output = getTableByName(name)!;
  expect(output).not.toBeNull();
  expect.soft(await readArtifact(output)).toEqual([{ value: expectedValue }]);
  expect.soft(edgesForStep(testAccountScope(), stepId)).toMatchObject([{
    inputTableId: input.id, inputTableName: input.name, boundArtifact: input.file,
  }]);
  expect.soft(edgesForStep(testAccountScope(), stepId)).toHaveLength(1);
  // First public service reads, independent of the persisted edge assertion.
  const single = await readStep(testAccountScope(), recipeId, stepId);
  const whole = await readRecipe(testAccountScope(), recipeId);
  for (const view of [single, whole.steps.find((s) => s.step.id === stepId)!]) {
    expect.soft(view.latestAttempt?.state).toBe("succeeded");
    expect.soft(view.condition.primary).toBe(condition);
    if (condition === "stale") {
      expect.soft(view.condition.causes).toEqual([{
        reason: "source_changed", tableId: input.id, tableName: input.name,
      }]);
    } else if (condition === "current") {
      expect.soft(view.condition.causes).toEqual([]);
    }
  }
  return output;
}

describe("lineage pinned to the run", () => {
  it("keeps copied lineage through real refresh and second registration, then reruns current", async () => {
    const s = step();
    const hold = holdAt("copied", s.id);
    const job = await startStepRun(testAccountScope(), s.id);
    await hold.reached();
    expect(getJob(job.id)!.state).toBe("running");
    const next = await refresh();
    expect((await executeQuery(SQL)).preview).toEqual([{ value: 2 }]);
    hold.release();
    await laneSettled();
    const oldOutput = await assertPublished(s.id, source, 1, "stale");
    await retirementsSettled();
    await expect(stat(path.join(dir, "data", source.file))).rejects.toMatchObject({ code: "ENOENT" });

    const rerun = await startStepRun(testAccountScope(), s.id);
    await laneSettled();
    expect(getJob(rerun.id)!.state).toBe("succeeded");
    const newOutput = await assertPublished(s.id, next, 2, "current");
    expect(newOutput.id).toBe(oldOutput.id);
    expect(newOutput.name).toBe(oldOutput.name);
    expect(newOutput.file).not.toBe(oldOutput.file);
  }, 60_000);

  it("keeps the original identity when another table reclaims the input name", async () => {
    const s = step();
    const hold = holdAt("copied", s.id);
    await startStepRun(testAccountScope(), s.id);
    await hold.reached();
    await removeTable(testAccountScope(), source.name);
    value = 2;
    await importFromUrl(testAccountScope(), url, source.name);
    const stranger = getTableByName(source.name)!;
    expect(stranger.id).not.toBe(source.id);
    expect(stranger.file).not.toBe(source.file);
    expect((await executeQuery(SQL)).preview).toEqual([{ value: 2 }]);
    hold.release();
    await laneSettled();
    await assertPublished(s.id, source, 1, "broken");
  }, 60_000);

  it("uses catalog evidence when refresh lands before the run registry read", async () => {
    const s = step();
    const hold = holdAt("registered", s.id);
    const job = await startStepRun(testAccountScope(), s.id);
    await hold.reached();
    expect(getJob(job.id)!.state).toBe("running");
    await refresh(); // No executeQuery or other shared-view registration here.
    hold.release();
    await laneSettled();
    await assertPublished(s.id, source, 1, "stale");
  }, 60_000);

  it.each(["registered", "pre-copy"] as const)("keeps execution on the bound input through a pre-copy refresh (%s)", async (point) => {
    const s = step();
    const hold = holdAt(point, s.id);
    await startStepRun(testAccountScope(), s.id);
    await hold.reached();
    await refresh();
    expect((await executeQuery(SQL)).preview).toEqual([{ value: 2 }]);
    hold.release();
    await laneSettled();
    await assertPublished(s.id, source, 1, "stale");
  }, 60_000);

  it("publishes an unchanged input with exact lineage and no causes", async () => {
    const s = step();
    const job = await startStepRun(testAccountScope(), s.id);
    await laneSettled();
    expect(getJob(job.id)!.state).toBe("succeeded");
    await assertPublished(s.id, source, 1, "current");
  }, 60_000);

  it("completes a stale producer and its dependent once, then a clean cascade stays current", async () => {
    process.env.DEZFIL_OPERATION_CONCURRENCY = "4";
    const one = step();
    const two = step("lineage_dependent", "SELECT value FROM lineage_output");
    const hold = holdAt("copied", one.id);
    const cascade = await startCascade(testAccountScope(), { recipeId });
    try {
      await hold.reached();
      await refresh();
      expect((await executeQuery(SQL)).preview).toEqual([{ value: 2 }]);
    } finally { hold.release(); }
    await cascadeSettled(cascade.id);
    const finished = readCascade(cascade.id);
    expect(finished.outcome).toBe("completed");
    expect(finished.members.map((m) => m.state)).toEqual(["succeeded", "succeeded"]);
    const producerJobs = listJobs({ subjectId: one.id });
    const dependentJobs = listJobs({ subjectId: two.id });
    expect(producerJobs).toHaveLength(1);
    expect(dependentJobs).toHaveLength(1);
    expect(dependentJobs[0].startedAt! >= producerJobs[0].finishedAt!).toBe(true);
    const producer = await assertPublished(one.id, source, 1, "stale");
    const dependent = getTableByName("lineage_dependent")!;
    expect(await readArtifact(dependent)).toEqual([{ value: 1 }]);
    expect(edgesForStep(testAccountScope(), two.id)).toMatchObject([{
      inputTableId: producer.id, inputTableName: producer.name, boundArtifact: producer.file,
    }]);
    expect(edgesForStep(testAccountScope(), two.id)).toHaveLength(1);
    for (const view of [await readStep(testAccountScope(), recipeId, two.id), (await readRecipe(testAccountScope(), recipeId)).steps[1]]) {
      expect(view.latestAttempt?.state).toBe("succeeded");
      expect.soft(view.condition.primary).toBe("stale");
      expect.soft(view.condition.causes).toEqual([{
        reason: "upstream_stale", tableId: producer.id,
        tableName: producer.name, producedByStepId: one.id,
      }]);
    }

    // Explicit user rerun, after both outputs have published. This is the clean
    // cascade control, with the same identities and now the current values.
    const clean = await startCascade(testAccountScope(), { recipeId });
    await cascadeSettled(clean.id);
    expect(readCascade(clean.id).outcome).toBe("completed");
    expect(readCascade(clean.id).members.map((m) => m.state)).toEqual(["succeeded", "succeeded"]);
    const recipe = await readRecipe(testAccountScope(), recipeId);
    expect(recipe.steps.map((s) => s.condition.primary)).toEqual(["current", "current"]);
    expect(recipe.steps.map((s) => s.condition.causes)).toEqual([[], []]);
    for (const [s, previous] of [[one, producer], [two, dependent]] as const) {
      expect(listJobs({ subjectId: s.id })).toHaveLength(2);
      const current = getTableByName(previous.name)!;
      expect(current.id).toBe(previous.id);
      expect(await readArtifact(current)).toEqual([{ value: 2 }]);
    }
  }, 60_000);
});
