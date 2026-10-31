import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb, MIGRATIONS } from "@/lib/metadata/db";
import { addStep, createRecipe, deleteRecipe, getStep } from "@/lib/metadata/recipes";
import { createCascade, getCascade } from "@/lib/metadata/cascades";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { getTableByName } from "@/lib/metadata/tables";
import { runnerOutput } from "@/lib/metadata/recipe-outputs";
import { resetQueryInstance } from "@/lib/duckdb";
import { boundedEvaluation } from "@/lib/query/bounded";
import { testAccountScope } from "@/lib/test-support/accounts";
import { startSingleRun, cascadeSettled } from "./cascade";

const scratch = process.env.DEZFIL_DATA_DIR!;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(scratch, "workflow-removal-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetQueryInstance();
});
afterEach(() => {
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each(["delete", "upgrade"])("removes workflow runs and members on %s while the produced dataset remains readable", async mode => {
  const scope = testAccountScope(), db = metadataDb();
  const recipe = createRecipe(scope, "Producer");
  const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "kept_output" } });
  const run = await startSingleRun(scope, recipe.id, step.id, {
    expectedRevision: readDocumentRevision({ kind: "workflow", id: recipe.id })!.editRevision,
  });
  await cascadeSettled(run.id);
  expect(getCascade(run.id)?.outcome).toBe("completed");
  expect(runnerOutput(step.id, scope.accountId)?.runId).toBe(run.id);
  const output = getTableByName("kept_output")!;
  expect(output).not.toBeNull();
  const survivor = createRecipe(scope, "Survivor");
  const survivorRun = createCascade(survivor.id, "run_all", []);
  if (mode === "delete") expect(deleteRecipe(recipe.id)).toBe(true);
  else {
    // Recreate the preceding schema; lowering only its version would replay
    // later table creation against tables that already exist.
    db.prepare("DELETE FROM recipes WHERE id = ?").run(recipe.id);
    const cleanup = MIGRATIONS.findIndex(sql => /DELETE FROM cascade_runs WHERE NOT EXISTS/.test(sql));
    expect(cleanup).toBeGreaterThanOrEqual(0);
    db.exec("DROP TRIGGER revoke_picture_work_on_inactive_owner; DROP TABLE map_pictures; ALTER TABLE accounts DROP COLUMN picture_version");
    db.exec(`DROP INDEX idx_accounts_external_identity;
      ALTER TABLE accounts DROP COLUMN external_identity;
      DROP TABLE auth_ticket_ids; DROP TABLE auth_generations;
      ALTER TABLE auth_sessions DROP COLUMN sign_out_generation;
      ALTER TABLE auth_sessions DROP COLUMN door_generation;
      ALTER TABLE auth_tokens DROP COLUMN sign_out_generation;
      ALTER TABLE auth_tokens DROP COLUMN door_generation;`);
    db.pragma(`user_version = ${cleanup}`);
    expect(getCascade(run.id)).not.toBeNull();
    closeMetadataDb();
  }
  expect(getCascade(run.id)).toBeNull();
  expect(metadataDb().prepare("SELECT * FROM cascade_members WHERE cascade_id = ?").all(run.id)).toEqual([]);
  expect(getCascade(survivorRun.id)?.recipeId).toBe(survivor.id);
  expect(getStep(step.id)).toBeNull();
  expect(runnerOutput(step.id, scope.accountId)).toBeNull();
  expect(getTableByName("kept_output")).toEqual(output);
  const rows = await boundedEvaluation(async conn => (await conn.runAndReadAll("SELECT x FROM kept_output")).getRowObjectsJson(), { scope });
  expect(rows).toEqual([{ x: 7 }]);
});
