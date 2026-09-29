import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import {
  addStep,
  createRecipe,
  discardProposal,
  editStep,
} from "@/lib/metadata/recipes";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { cascadeSettled, startSingleRun } from "./cascade";
import { resetLane } from "./lane";
import { readRecipe } from "./recipe-view";

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "stations.csv");
  await writeFile(source, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), source, "stations.csv");
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const sql = (query: string, name: string) => ({
  operation: "sql_step",
  parameters: { sql: query, name },
});

async function publish(recipeId: string, stepId: string) {
  const run = await startSingleRun(testAccountScope(), recipeId, stepId);
  await cascadeSettled(run.id);
  const step = (await readRecipe(recipeId)).steps.find((candidate) => candidate.step.id === stepId);
  expect(step?.step.outputTableId).not.toBeNull();
}

describe("prospective missing inputs use the next-run definition", () => {
  it("keeps a published downstream step current when its producer's pending missing input is prospective-only, then restores the producer on discard", async () => {
    const recipe = createRecipe(testAccountScope(), "Pending missing with live downstream");
    const producer = addStep(
      recipe.id,
      sql("SELECT name FROM stations", "published_a"),
    );
    await publish(recipe.id, producer.id);
    const consumer = addStep(
      recipe.id,
      sql("SELECT * FROM published_a", "published_b"),
    );
    await publish(recipe.id, consumer.id);

    const before = await readRecipe(recipe.id);
    expect(before.steps.map((candidate) => candidate.condition.primary)).toEqual([
      "current",
      "current",
    ]);
    expect(before.summary).toMatchObject({ status: "up_to_date", count: 0 });
    expect(
      editStep(producer.id, {
        sql: "SELECT * FROM pending_table_that_does_not_exist",
        name: "published_a",
      }),
    ).toBe("proposed");

    const view = await readRecipe(recipe.id);
    const pending = view.steps.find(
      (candidate) => candidate.step.id === producer.id,
    )!;
    const downstream = view.steps.find(
      (candidate) => candidate.step.id === consumer.id,
    )!;
    expect(pending.reads).toEqual(["pending_table_that_does_not_exist"]);
    expect(pending.condition.primary).toBe("broken");
    expect(pending.condition.conditions).toContain("broken");
    expect(pending.condition.missingInputs.map((input) => input.tableName)).toEqual([
      "pending_table_that_does_not_exist",
    ]);
    expect(downstream.condition.conditions).toEqual(["current"]);
    expect(view.summary).toMatchObject({ status: "cannot_run", count: 1 });

    discardProposal(producer.id);
    const restored = await readRecipe(recipe.id);
    expect(restored.steps.map((candidate) => candidate.condition.primary)).toEqual([
      "current",
      "current",
    ]);
    expect(restored.summary).toMatchObject({ status: "up_to_date", count: 0 });
  }, 60_000);

  it("keeps the never-published missing-table condition", async () => {
    const recipe = createRecipe(testAccountScope(), "Never published missing");
    const step = addStep(
      recipe.id,
      sql("SELECT * FROM unpublished_table_that_does_not_exist", "never_out"),
    );

    const view = await readRecipe(recipe.id);
    const unpublished = view.steps.find((candidate) => candidate.step.id === step.id)!;
    expect(unpublished.condition.conditions).toEqual(["broken", "never_run"]);
    expect(unpublished.condition.missingInputs.map((input) => input.tableName)).toEqual([
      "unpublished_table_that_does_not_exist",
    ]);
    expect(view.summary).toMatchObject({ status: "cannot_run", count: 1 });
  });

  it("marks an unpublished forward reference to a later producer broken", async () => {
    const recipe = createRecipe(testAccountScope(), "Forward reference");
    const forward = addStep(
      recipe.id,
      sql("SELECT * FROM produced_later", "forward_consumer"),
    );
    addStep(recipe.id, sql("SELECT name FROM stations", "produced_later"));

    const view = await readRecipe(recipe.id);
    const unpublished = view.steps.find(
      (candidate) => candidate.step.id === forward.id,
    )!;
    expect(unpublished.reads).toEqual(["produced_later"]);
    expect(unpublished.condition.conditions).toEqual(["broken", "never_run"]);
    expect(unpublished.condition.missingInputs.map((input) => input.tableName)).toEqual([
      "produced_later",
    ]);
    expect(view.summary).toMatchObject({ status: "cannot_run", count: 1 });
  });

  it("treats a name an earlier step will produce as a dependency, not missing", async () => {
    const recipe = createRecipe(testAccountScope(), "Planned dependency");
    addStep(recipe.id, sql("SELECT name FROM stations", "planned_source"));
    const consumer = addStep(
      recipe.id,
      sql("SELECT name FROM stations", "planned_consumer"),
    );
    await publish(recipe.id, consumer.id);
    expect(
      editStep(
        consumer.id,
        sql("SELECT * FROM planned_source", "planned_consumer").parameters,
      ),
    ).toBe("proposed");

    const view = await readRecipe(recipe.id);
    const pending = view.steps.find((candidate) => candidate.step.id === consumer.id)!;
    expect(pending.reads).toEqual(["planned_source"]);
    expect(pending.condition.conditions).not.toContain("broken");
    expect(pending.condition.missingInputs).toEqual([]);
    expect(view.summary).toMatchObject({ status: "run_again", count: 1 });
  }, 60_000);

  it("keeps an unreadable pending definition as no reads, never broken", async () => {
    const recipe = createRecipe(testAccountScope(), "Unreadable proposal");
    const step = addStep(recipe.id, sql("SELECT name FROM stations", "unreadable_out"));
    await publish(recipe.id, step.id);
    expect(
      editStep(step.id, { sql: "SELEC nonsense FROM", name: "unreadable_out" }),
    ).toBe("proposed");

    const view = await readRecipe(recipe.id);
    const pending = view.steps.find((candidate) => candidate.step.id === step.id)!;
    expect(pending.reads).toEqual([]);
    expect(pending.condition.conditions).not.toContain("broken");
    expect(pending.condition.missingInputs).toEqual([]);
    expect(view.summary).toMatchObject({ status: "run_again", count: 1 });
  }, 60_000);
});
