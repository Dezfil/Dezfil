import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { getCascade } from "@/lib/metadata/cascades";
import * as scopedRuns from "@/lib/metadata/owned-cascades";
import { getJob, isTerminal, listJobs } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { readHold } from "@/lib/test-support/read-hold";
import { inspectTable } from "@/lib/table-service";
import { cascadeSettled, startSingleRun } from "./cascade";
import { cancelRun } from "./run";
import { isExecuting, laneSettled, resetLane } from "./lane";
import * as materialization from "./materialize";

const scratch = process.env.DEZFIL_DATA_DIR!;
let directory: string, runs: string[];
beforeEach(() => {
  directory = mkdtempSync(path.join(scratch, "cascade-wait-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane(); runs = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  metadataDb().prepare("UPDATE accounts SET status = 'active'").run();
  const scope = testAccountScope();
  for (const job of listJobs()) if (!isTerminal(job.state)) await cancelRun(scope, job.id);
  await laneSettled(); await Promise.all(runs.map(cascadeSettled));
  vi.useRealTimers(); resetLane(); closeMetadataDb(); resetQueryInstance();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

async function heldMember() {
  const scope = testAccountScope(), recipe = createRecipe(scope, "Polling during execution");
  const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "poll_output" } });
  const hold = readHold("member execution"), original = materialization.materialize;
  let signal: AbortSignal | undefined;
  vi.spyOn(materialization, "materialize").mockImplementation(async (...args) => {
    signal = args[1].signal; await hold.engage(); return original(...args);
  });
  const run = await startSingleRun(scope, recipe.id, step.id, {
    expectedRevision: readDocumentRevision({ kind: "workflow", id: recipe.id })!.editRevision });
  runs.push(run.id);
  return { scope, run, hold, signal: () => signal, jobId: run.members[0].jobId! };
}

it.each([1, 3])("publishes a healthy member after %i failed removal polls and logs once", async failures => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const member = await heldMember();
  try {
    await member.hold.beforeMutation();
    expect(getJob(member.jobId)?.state).toBe("running");
    expect(isExecuting(member.jobId)).toBe(true);
    const outage = new Error("Temporary metadata read failure");
    const read = vi.spyOn(scopedRuns, "getCascade");
    for (let i = 0; i < failures; i++) {
      read.mockImplementationOnce(() => { throw outage; });
      await vi.advanceTimersByTimeAsync(250);
    }
    read.mockRestore();
    member.hold.release(); await cascadeSettled(member.run.id);
    expect(getCascade(member.run.id)?.outcome).toBe("completed");
    expect(getJob(member.jobId)?.state).toBe("succeeded");
    expect((await inspectTable(member.scope, "poll_output")).preview).toEqual([{ x: 7 }]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledExactlyOnceWith(expect.any(String), outage);
    expect(vi.getTimerCount()).toBe(0);
  } finally { member.hold.release(); }
});

it("stops an inactive initiator's executing member on the next poll before publication", async () => {
  const errors = vi.spyOn(console, "error"), warnings = vi.spyOn(console, "warn");
  const member = await heldMember();
  try {
    await member.hold.beforeMutation();
    expect(isExecuting(member.jobId)).toBe(true);
    expect(member.signal()?.aborted).toBe(false);
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(member.scope.accountId);
    await vi.advanceTimersByTimeAsync(249);
    expect(getJob(member.jobId)?.state).toBe("running");
    expect(member.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(member.signal()?.aborted).toBe(true);
    expect(getJob(member.jobId)).toMatchObject({ state: "failed", errorCode: "authentication_required", outputId: null });
    member.hold.release(); await cascadeSettled(member.run.id);
    expect(isExecuting(member.jobId)).toBe(false);
    expect(getCascade(member.run.id)).toMatchObject({ outcome: "failed", members: [{
      state: "failed", stoppedBy: "authentication_required", output: null,
      attempt: { state: "failed", error: { code: "authentication_required" } },
    }] });
    expect(getTableByName("poll_output")).toBeNull();
    expect(errors).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { member.hold.release(); }
});
