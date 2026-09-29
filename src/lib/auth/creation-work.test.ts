import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, duplicateMap } from "@/lib/map-service";
import { createSketch } from "@/lib/sketch/store";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { duplicateRecipe } from "@/lib/operations/recipe-duplicate";
import { startRun } from "@/lib/operations/run";
import { startStepRun } from "@/lib/operations/step-execution";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { getJob } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { retirementsSettled } from "@/lib/ingest/retire";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "creators-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  await mkdir(path.join(directory, "tables"));
});
afterEach(async () => {
  await laneSettled(); await retirementsSettled();
  resetLane(); resetQueryInstance(); closeMetadataDb();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function owner(kind: string, id: string) {
  return (metadataDb().prepare(`SELECT owner_id FROM ${kind} WHERE id = ?`).get(id) as { owner_id: string }).owner_id;
}

it("carries each creator through uploads, sketches, duplication and background output commits", async () => {
  const source = path.join(directory, "roads.csv");
  await writeFile(source, "name,lon,lat\nMain,13.4,52.5\n");
  for (const id of ["alice", "bob"]) {
    const scope = testAccountScope(undefined, id);
    const table = await ingestFile(scope, source, `${id}.csv`);
    expect(owner("data_tables", table.id)).toBe(id);
    const map = createMap(scope, id);
    expect(owner("maps", duplicateMap(scope, map.id).id)).toBe(id);
    const sketch = await createSketch(scope, map.id, { kind: "point", geometry: { type: "Point", coordinates: [13.4, 52.5] } });
    expect(owner("data_tables", sketch.table.id)).toBe(id);

    const recipe = createRecipe(scope, id, undefined, "builder");
    expect(owner("recipes", recipe.id)).toBe(id);
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: `SELECT * FROM ${table.name}`, name: `${id}_step` } });
    const job = await startStepRun(scope, step.id);
    await laneSettled();
    const done = getJob(job.id)!;
    expect(done.state).toBe("succeeded");
    expect(owner("operation_jobs", done.id)).toBe(id);
    expect(owner("data_tables", done.outputId!)).toBe(id);
    const rerun = await startStepRun(scope, step.id);
    await laneSettled();
    expect(getJob(rerun.id)?.outputId).toBe(done.outputId);
    expect(owner("data_tables", done.outputId!)).toBe(id);

    const workflow = createRecipe(scope, `${id} workflow`);
    expect(owner("recipes", (await duplicateRecipe(scope, workflow.id)).id)).toBe(id);
    const standalone = await startRun(scope, { operation: "sql_step", parameters: { sql: "SELECT 1 AS n", name: `${id}_standalone` } });
    await laneSettled();
    expect(getJob(standalone.id)?.state).toBe("succeeded");
    expect(owner("operation_jobs", standalone.id)).toBe(id);
    expect(owner("data_tables", getTableByName(`${id}_standalone`)!.id)).toBe(id);
  }
});
