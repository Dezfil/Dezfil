import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe, getStep } from "@/lib/metadata/recipes";
import { insertMap, type MapRecord } from "@/lib/metadata/maps";
import { createMap, duplicateMap } from "@/lib/map-service";
import { startStepRun } from "./step-execution";
import { cascadeSettled, startCascade } from "./cascade";
import { duplicateRecipe } from "./recipe-duplicate";
import { laneSettled, resetLane } from "./lane";

/**
 * A completed step writes its output twice: the step's own association, and
 * a row keyed by the step and the account that ran it. Readers still use the
 * first; the second exists so that nothing completed now is missing when
 * they move to it.
 */

let dir: string;
beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "runner-outputs-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "stations.csv");
  await writeFile(source, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), source, "stations.csv");
});
afterEach(async () => {
  await laneSettled();
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const rows = (sql: string, ...args: unknown[]) => metadataDb().prepare(sql).all(...args);

describe("a step completed after the upgrade", () => {
  it("records the runner's output, job and run beside the step's own association", async () => {
    const scope = testAccountScope();
    const recipe = createRecipe(scope, "Stations");
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT name FROM stations", name: "named_stations" } });

    const job = await startStepRun(scope, step.id);
    await laneSettled();
    const alone = getStep(step.id)!;
    expect(alone.outputTableId).not.toBeNull();
    expect(rows("SELECT runner_id, output_table_id, output_table_name, job_id, run_id FROM step_runner_outputs WHERE step_id = ?", step.id))
      .toEqual([{ runner_id: "test-account", output_table_id: alone.outputTableId, output_table_name: "named_stations", job_id: job.id, run_id: null }]);

    const run = await startCascade(scope, { expectedRevision: readEditRevision({ kind: "workflow", id: recipe.id })?.editRevision, recipeId: recipe.id });
    await cascadeSettled(run.id);
    await laneSettled();
    const member = (rows("SELECT job_id FROM cascade_members WHERE cascade_id = ?", run.id) as { job_id: string }[])[0];
    const rerun = getStep(step.id)!;
    expect(rows("SELECT runner_id, output_table_id, job_id, run_id, succeeded_at FROM step_runner_outputs WHERE step_id = ?", step.id))
      .toEqual([{ runner_id: "test-account", output_table_id: rerun.outputTableId, job_id: member.job_id, run_id: run.id, succeeded_at: rerun.lastSuccessAt }]);
    expect(rows("SELECT initiator_id FROM cascade_runs WHERE id = ?", run.id)).toEqual([{ initiator_id: "test-account" }]);
    expect(rows("SELECT DISTINCT runner_id FROM lineage_edges WHERE step_id = ?", step.id)).toEqual([{ runner_id: "test-account" }]);
  }, 60_000);
});

describe("SQL homes on the creation paths", () => {
  it("stamps the creator on map and workflow creation and keeps the source's home on duplication", async () => {
    const scope = testAccountScope();
    testAccountScope(metadataDb(), "elsewhere");
    const created = createMap(scope, "Created");
    const recipe = createRecipe(scope, "Created workflow");
    const now = new Date().toISOString();
    const homed: MapRecord = { ...created, id: "homed-map", name: "Homed", createdAt: now, updatedAt: now };
    insertMap(scope, homed, metadataDb(), "elsewhere");
    const homedRecipe = createRecipe(scope, "Homed workflow", metadataDb(), "workflow", "elsewhere");
    addStep(homedRecipe.id, { operation: "sql_step", parameters: { sql: "SELECT name FROM stations", name: "homed_out" } });

    const mapCopy = duplicateMap(scope, created.id);
    const homedCopy = duplicateMap(scope, homed.id);
    const recipeCopy = await duplicateRecipe(scope, recipe.id);
    const homedRecipeCopy = await duplicateRecipe(scope, homedRecipe.id);
    const home = (relation: string, id: string) =>
      (metadataDb().prepare(`SELECT owner_id, home_account_id FROM ${relation} WHERE id = ?`).get(id));
    expect(home("maps", created.id)).toEqual({ owner_id: "test-account", home_account_id: "test-account" });
    expect(home("maps", mapCopy.id)).toEqual({ owner_id: "test-account", home_account_id: "test-account" });
    expect(home("maps", homedCopy.id)).toEqual({ owner_id: "test-account", home_account_id: "elsewhere" });
    expect(home("recipes", recipe.id)).toEqual({ owner_id: "test-account", home_account_id: "test-account" });
    expect(home("recipes", recipeCopy.id)).toEqual({ owner_id: "test-account", home_account_id: "test-account" });
    expect(home("recipes", homedRecipeCopy.id)).toEqual({ owner_id: "test-account", home_account_id: "elsewhere" });
  });
});
