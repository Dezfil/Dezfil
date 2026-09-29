import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getTableByName, listTables } from "@/lib/metadata/tables";
import { getJob, listJobs } from "@/lib/metadata/jobs";
import {
  addStep,
  createRecipe,
  deleteRecipe,
  editStep,
  getStep,
  listSteps,
  removeStep,
} from "@/lib/metadata/recipes";
import { edgesForStep } from "@/lib/metadata/lineage";
import { removeTable } from "@/lib/table-service";
import { startStepRun } from "./step-execution";
import { readRecipe, readStep } from "./recipe-view";
import { laneSettled, resetLane } from "./lane";

/**
 * What a step's departure leaves behind.
 *
 * The rule these all serve is one sentence: **a deletion never erases the
 * evidence of what it broke**. A removed step keeps its output and its history;
 * a step that reads that output keeps reading it, as an ordinary workspace
 * table, because the edge names a table and never named the step.
 */

let dir: string;
let recipeId: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  recipeId = createRecipe(testAccountScope(), "R").id;
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const step = (sql: string, name: string) =>
  addStep(recipeId, { operation: "sql_step", parameters: { sql, name } });

async function run(stepId: string) {
  const job = await startStepRun(testAccountScope(), stepId);
  await laneSettled();
  return getJob(job.id)!;
}

describe("removing a completed step (G3)", () => {
  it("keeps its output table registered and queryable", async () => {
    const first = step("SELECT name FROM stations", "kept_output");
    expect((await run(first.id)).state).toBe("succeeded");

    expect(removeStep(first.id)).toBe(true);

    expect(listSteps(recipeId)).toHaveLength(0);
    const table = getTableByName("kept_output");
    expect(table).not.toBeNull();
    expect(Number((await executeQuery("SELECT count(*) AS n FROM kept_output")).preview[0].n))
      .toBe(2);
  }, 60_000);

  it("keeps the step's run history", async () => {
    const first = step("SELECT 1 AS n", "history_output");
    await run(first.id);
    removeStep(first.id);

    // The runs were the step's own subject, and they outlive it — a removed
    // step's history is evidence, not bookkeeping attached to a row.
    const history = listJobs({ subjectId: first.id });
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("succeeded");
    expect(history[0].outputName).toBe("history_output");
  }, 60_000);

  it("leaves a downstream step reading that table as an ordinary input", async () => {
    const producer = step("SELECT name FROM stations", "upstream_out");
    await run(producer.id);
    const consumer = step("SELECT count(*) AS n FROM upstream_out", "downstream_out");
    await run(consumer.id);

    removeStep(producer.id);

    // The consumer keeps its edge — it still reads that table — and is
    // *current*, not broken: nothing it depends on went away.
    expect(edgesForStep(consumer.id).map((e) => e.inputTableName)).toEqual([
      "upstream_out",
    ]);
    const view = (await readRecipe(recipeId));
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0].condition.primary).toBe("current");
  }, 90_000);

  it("closes the gap it left, so later steps stay in order", async () => {
    const a = step("SELECT 1 AS n", "a_out");
    const b = step("SELECT 2 AS n", "b_out");
    const c = step("SELECT 3 AS n", "c_out");
    removeStep(b.id);

    // Dense ordinals are what make "earlier than" — the whole validity rule —
    // unambiguous after a removal.
    expect(listSteps(recipeId).map((s) => [s.id, s.ordinal])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);
  });
});

describe("a condition is not a job state", () => {
  /** Slow enough to blow a one-second budget, fast enough for the default. */
  const SLOWISH =
    "SELECT count(*) AS n FROM range(40000) a, range(40000) b " +
    "WHERE (a.range * b.range) % 7 = 3";

  it("leaves a current step current when a voluntary re-run of it fails", async () => {
    const s = step(SLOWISH, "still_current");
    expect((await run(s.id)).state).toBe("succeeded");
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("current");

    // The step is **unchanged** — what fails is the budget it runs under, so
    // this is genuinely a re-run of a current step rather than a different
    // step that happens to fail. A fifth of a second against a query that took
    // seconds: the margin is decisive rather than marginal, so the case does
    // not turn into a race under load.
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "0.2";
    let failed;
    try {
      failed = await run(s.id);
    } finally {
      delete process.env.DEZFIL_OPERATION_TIMEOUT_S;
    }
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("operation_timeout");

    const view = await readStep(recipeId, s.id);
    // Fresh output, latest attempt failed — the combination a model that
    // collapsed condition into job state could not express.
    expect(view.condition.primary).toBe("current");
    expect(view.latestAttempt?.state).toBe("failed");
    // And yesterday's answer is still served.
    expect(
      Number((await executeQuery("SELECT n FROM still_current")).preview[0].n),
    ).toBeGreaterThan(0);
  }, 180_000);
});

describe("deleting a recipe", () => {
  it("leaves every output table registered and queryable", async () => {
    const a = step("SELECT name FROM stations", "recipe_out_a");
    await run(a.id);
    const b = step("SELECT count(*) AS n FROM recipe_out_a", "recipe_out_b");
    await run(b.id);

    expect(deleteRecipe(recipeId)).toBe(true);

    // A recipe is the record of how its outputs were made, not their owner.
    for (const name of ["recipe_out_a", "recipe_out_b"]) {
      expect(getTableByName(name)).not.toBeNull();
      expect(
        Number((await executeQuery(`SELECT count(*) AS n FROM ${name}`)).preview[0].n),
      ).toBeGreaterThan(0);
    }
    expect(listSteps(recipeId)).toHaveLength(0);
  }, 90_000);
});

describe("an output deleted under its step", () => {
  it("leaves the step output missing, and a re-run repairs it under a NEW id", async () => {
    const s = step("SELECT name FROM stations", "repairable");
    await run(s.id);
    const originalId = getTableByName("repairable")!.id;

    await removeTable("repairable");
    expect((await readRecipe(recipeId)).steps[0].condition.conditions).toContain(
      "output_missing",
    );

    const repaired = await run(s.id);
    expect(repaired.state).toBe("succeeded");
    const now = getTableByName("repairable")!;
    // A deleted table's id is gone; a repair registers a new dataset under the
    // recorded name, and the step records the new identity. Resurrecting the
    // old id would be inventing identity, which is the wrong reading even
    // though both are implementable.
    expect(now.id).not.toBe(originalId);
    expect((await readStep(recipeId, s.id)).step.outputTableId).toBe(now.id);
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("current");
  }, 90_000);

  it("reports a naming conflict and writes nothing once the name is reclaimed", async () => {
    const s = step("SELECT name FROM stations", "reclaimed");
    await run(s.id);
    await removeTable("reclaimed");

    // Someone else takes the name back.
    const usurper = step("SELECT 42 AS answer", "reclaimed");
    await run(usurper.id);
    const usurperId = getTableByName("reclaimed")!.id;

    await expect(startStepRun(testAccountScope(), s.id)).rejects.toMatchObject({
      code: "name_taken",
      status: 409,
    });
    // Nothing written: the other table is untouched, and what the user is
    // *offered* at this moment belongs to, not here.
    expect(getTableByName("reclaimed")!.id).toBe(usurperId);
    expect((await executeQuery("SELECT answer FROM reclaimed")).preview[0].answer).toBe(42);
  }, 90_000);
});

describe("an input deleted under its readers", () => {
  it("breaks dependents transitively, keeping what they recorded", async () => {
    const one = step("SELECT name FROM stations", "chain_one");
    await run(one.id);
    const two = step("SELECT count(*) AS n FROM chain_one", "chain_two");
    await run(two.id);
    const three = step("SELECT n * 2 AS m FROM chain_two", "chain_three");
    await run(three.id);
    const oneId = getTableByName("chain_one")!.id;

    await removeTable("chain_one");

    const view = (await readRecipe(recipeId));
    const [first, second, third] = view.steps;
    // One hop.
    expect(first.condition.conditions).toContain("output_missing");
    expect(second.condition.primary).toBe("broken");
    expect(second.condition.missingInputs[0]).toMatchObject({
      tableId: oneId,
      tableName: "chain_one",
    });
    // Two hops: a step whose producer cannot run cannot run either.
    expect(third.condition.primary).toBe("broken");
    expect(third.condition.missingInputs[0].throughStepId).toBe(two.id);
    // The deletion never erased the evidence of what it broke.
    expect(second.edges[0].inputTableName).toBe("chain_one");
    expect(second.edges[0].inputTableId).toBe(oneId);
  }, 120_000);

  it("names a lost external source exactly once for a published reader", async () => {
    const producer = step("SELECT name FROM stations", "dedupe_out");
    await run(producer.id);
    const stationsId = getTableByName("stations")!.id;

    await removeTable("stations");

    const view = await readStep(recipeId, producer.id);
    expect(view.condition.primary).toBe("broken");
    // The whole array: the recorded lineage edge alone carries the loss.
    // A second, prospective entry with the synthetic missing: id doubled
    // the evidence and the panel sentence.
    expect(view.condition.missingInputs).toEqual([
      expect.objectContaining({ tableId: stationsId, tableName: "stations" }),
    ]);
  }, 90_000);

  it("reports both conditions when a step loses an input AND its output", async () => {
    const producer = step("SELECT name FROM stations", "both_source");
    await run(producer.id);
    const consumer = step("SELECT count(*) AS n FROM both_source", "both_out");
    await run(consumer.id);

    await removeTable("both_source");
    await removeTable("both_out");

    const view = await readStep(recipeId, consumer.id);
    expect(view.condition.conditions).toEqual(["broken", "output_missing"]);
    // Un-runnable before un-current: offering a re-run that cannot succeed
    // tells the user the wrong thing.
    expect(view.condition.primary).toBe("broken");
  }, 120_000);
});

describe("editing a step is reflected in a later read", () => {
  it("lands on the definition when nothing has been produced yet", async () => {
    const s = step("SELECT 1 AS n", "unrun");
    expect(editStep(s.id, { sql: "SELECT 2 AS n", name: "unrun" })).toBe("active");
    expect((await readRecipe(recipeId)).steps[0].step.parameters).toEqual({
      sql: "SELECT 2 AS n",
      name: "unrun",
    });
  });

  it("is held as a proposal once the step has an output", async () => {
    const s = step("SELECT 1 AS n", "produced");
    await run(s.id);
    expect(editStep(s.id, { sql: "SELECT 2 AS n", name: "produced" })).toBe(
      "proposed",
    );

    const view = (await readRecipe(recipeId)).steps[0];
    // The step still means what its output was produced from, and says what is
    // waiting — the two facts a surface needs to explain the difference.
    expect(view.step.parameters).toEqual({ sql: "SELECT 1 AS n", name: "produced" });
    expect(view.step.proposedParameters).toEqual({
      sql: "SELECT 2 AS n",
      name: "produced",
    });
    expect(view.condition.primary).toBe("current");
    expect(view.latestAttempt?.state).toBe("succeeded");
    expect(listTables().some((t) => t.name === "produced")).toBe(true);
  }, 60_000);
});

describe("a step that has never run can still be broken", () => {
  it("reports broken alongside never run when its declared input is gone", async () => {
    // Lineage does not exist until a run succeeds, so a model that derived
    // conditions from edges alone could only ever say "never run" here — and
    // would offer a re-run that cannot succeed, which tells the user the
    // wrong thing.
    const s = step("SELECT count(*) AS n FROM stations", "not_yet");
    expect((await readStep(recipeId, s.id)).condition.conditions).toEqual([
      "never_run",
    ]);

    await removeTable("stations");

    const view = await readStep(recipeId, s.id);
    expect(view.condition.conditions).toEqual(["broken", "never_run"]);
    expect(view.condition.primary).toBe("broken");
    expect(view.condition.missingInputs[0].tableName).toBe("stations");
  }, 60_000);

  it("does not call a step broken for reading a step that has not run yet", async () => {
    // The ordinary case of a freshly authored recipe: the second step reads the
    // first step's output, which does not exist because nothing has run. That
    // is a dependency, not a missing input, and calling it broken would mark
    // every new recipe as damaged before its first run.
    step("SELECT name FROM stations", "fresh_one");
    const second = step("SELECT count(*) AS n FROM fresh_one", "fresh_two");

    const view = await readStep(recipeId, second.id);
    expect(view.condition.conditions).toEqual(["never_run"]);
    expect(view.condition.missingInputs).toEqual([]);
  }, 60_000);
});

describe("a re-authored step brings its origin with it", () => {
  it("promotes the new layer's origin only when the proposal succeeds", async () => {
    const s = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT name FROM stations", name: "authored" },
      origin: { layerId: "layer-a", layerName: "A", substitutedSource: false },
    });
    await run(s.id);
    expect((await readStep(recipeId, s.id)).step.origin).toMatchObject({
      layerId: "layer-a",
    });

    editStep(
      s.id,
      { sql: "SELECT name FROM stations LIMIT 1", name: "authored" },
      undefined,
      { layerId: "layer-b", layerName: "B", substitutedSource: false },
    );
    // Until the proposal runs, the step still means what its output came from —
    // and so does the origin describing it.
    expect((await readStep(recipeId, s.id)).step.origin).toMatchObject({
      layerId: "layer-a",
    });

    await run(s.id);
    expect((await readStep(recipeId, s.id)).step.origin).toMatchObject({
      layerId: "layer-b",
    });
    expect(getStep(s.id)!.proposedOrigin).toBeNull();
  }, 90_000);

  it("stops claiming a layer when the SQL is re-authored by hand", async () => {
    const s = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT name FROM stations", name: "handwritten" },
      origin: { layerId: "layer-a", layerName: "A", substitutedSource: true },
    });
    await run(s.id);

    // No layer named, and the SQL now reads something else entirely. Keeping
    // the old origin would have the API report a substitution note and a
    // filter count for a query that was never captured from anything.
    editStep(s.id, { sql: "SELECT 1 AS n", name: "handwritten" });
    await run(s.id);
    expect((await readStep(recipeId, s.id)).step.origin).toBeNull();
  }, 90_000);

  it("keeps the origin when an edit leaves the SQL alone", async () => {
    const s = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT name FROM stations", name: "same_sql" },
      origin: { layerId: "layer-a", layerName: "A", substitutedSource: false },
    });
    await run(s.id);

    // Renaming the output does not change where the query came from.
    editStep(s.id, { sql: "SELECT name FROM stations", name: "same_sql_two" });
    await run(s.id);
    expect((await readStep(recipeId, s.id)).step.origin).toMatchObject({
      layerId: "layer-a",
    });
  }, 90_000);
});
