import { testAccountScope } from "@/lib/test-support/accounts";
import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { getTableByName } from "@/lib/metadata/tables";
import {
  changeMembers,
  createProject,
  tableProjectIds,
} from "@/lib/metadata/projects";
import { submitRun } from "./run";
import { stepOutputFiler } from "./step-execution";

/**
 * The at-commit race, exercised (found at review): the run STARTS while
 * the workflow is in project A, the workflow moves to B while the run is
 * paused inside its own preparation, and the
 * output files where the workflow is at the publishing commit — B. A
 * start-time capture would file A; the divergence is the proof.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

it("an output publishing after a mid-run move files where the workflow is at the commit", async () => {
  const a = createProject(testAccountScope(), { name: "A" });
  const b = createProject(testAccountScope(), { name: "B" });
  const recipe = createRecipe(testAccountScope(), "Raced", undefined, "workflow");
  changeMembers(a.id, { addRecipes: [recipe.id] });
  const step = addStep(recipe.id, {
    operation: "sql_step",
    parameters: { sql: "SELECT 1 AS x", name: "raced_out" },
    origin: null,
  });

  const capturedAtStart = a.id; // what a start-time capture would file
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const job = await submitRun(testAccountScope(), {
    operationId: "sql_step",
    parameters: { sql: "SELECT 1 AS x", name: "raced_out" },
    sql: "SELECT 1 AS x",
    name: "raced_out",
    subject: step.id,
    subjectKind: "step",
    onPublished: stepOutputFiler(step.id),
    // The pause: the run is accepted and in flight, its publication not
    // yet begun, while the workflow moves underneath it.
    prepare: async () => {
      await gate;
      return {
        sql: "SELECT 1 AS x",
        disclosure: { sql: "SELECT 1 AS x" },
        cleanup: async () => {},
      };
    },
  });
  expect(job.state === "queued" || job.state === "running").toBe(true);

  changeMembers(b.id, { addRecipes: [recipe.id] });
  release();
  await laneSettled();

  const out = getTableByName("raced_out");
  expect(out).not.toBeNull();
  const filed = tableProjectIds().get(out!.id);
  expect(filed).toEqual([b.id]);
  expect(filed).not.toEqual([capturedAtStart]);
});
