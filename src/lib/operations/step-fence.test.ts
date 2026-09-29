import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getTableByName } from "@/lib/metadata/tables";
import { getJob } from "@/lib/metadata/jobs";
import {
  addStep,
  createRecipe,
  deleteRecipe,
  editStep,
  removeStep,
} from "@/lib/metadata/recipes";
import { LostAuthority, materialize } from "./materialize";
import { startStepRun } from "./step-execution";
import { laneSettled, resetLane } from "./lane";

/**
 * E10's fence: a run that lost its claim may finish computing, but may not
 * publish.
 *
 * **Three arms, not one.** "Deleted *or* superseded *or* its recipe deleted"
 * reads as one rule and is three code paths — a step row that vanished, a step
 * row whose definition moved, and a cascade delete that took the row with it.
 * One arm standing for all three is exactly the overclaimed closure the review
 * rules name.
 *
 * **And the fence settles the job.** A cancel writes `cancelled` before it
 * signals, so it owns the outcome; nothing writes an outcome when a step is
 * deleted or superseded, and a run left non-terminal would stay watchably
 * active forever. G6 settles it *failed* with `operation_superseded` rather
 * than adding a sixth state.
 */

let dir: string;
let recipeId: string;

/** Long enough to be certainly still executing when the test acts on it. */
const SLOW =
  "SELECT a.range AS n FROM range(40000) a, range(40000) b " +
  "WHERE (a.range * b.range) % 7 = 3";

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

const tablesDir = () => path.join(dir, "data", "tables");

/**
 * Wait until the run has begun writing its artifact.
 *
 * Acting before this proves nothing: a claim revoked before any work started
 * leaves things alone in every implementation, including one that truncates
 * the live output on its way past.
 */
async function untilWriting(before: Set<string>): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const now = await readdir(tablesDir());
    if (now.some((f) => !before.has(f))) return;
    if (Date.now() > deadline) throw new Error("the run never began writing");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the lost-authority fence", () => {
  it("publishes nothing when the step is DELETED mid-run", async () => {
    const s = step(SLOW, "deleted_step_out");
    const before = new Set(await readdir(tablesDir()));
    const job = await startStepRun(testAccountScope(), s.id);
    await untilWriting(before);

    removeStep(s.id);
    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("operation_superseded");
    expect(settled.outputId).toBeNull();
    expect(getTableByName("deleted_step_out")).toBeNull();
    // No stranded artifact either.
    expect((await readdir(tablesDir())).filter((f) => !before.has(f))).toEqual([]);
  }, 180_000);

  it("publishes nothing when the step is SUPERSEDED mid-run", async () => {
    const s = step(SLOW, "superseded_step_out");
    const before = new Set(await readdir(tablesDir()));
    const job = await startStepRun(testAccountScope(), s.id);
    await untilWriting(before);

    // The step has produced nothing yet, so this edit lands on the active
    // definition rather than becoming a proposal — the arm a proposal-only
    // check would miss.
    editStep(s.id, { sql: "SELECT 1 AS n", name: "superseded_step_out" });
    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("operation_superseded");
    expect(getTableByName("superseded_step_out")).toBeNull();
    expect((await readdir(tablesDir())).filter((f) => !before.has(f))).toEqual([]);
  }, 180_000);

  it("publishes nothing when the whole RECIPE is deleted mid-run", async () => {
    const s = step(SLOW, "deleted_recipe_out");
    const before = new Set(await readdir(tablesDir()));
    const job = await startStepRun(testAccountScope(), s.id);
    await untilWriting(before);

    expect(deleteRecipe(recipeId)).toBe(true);
    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("operation_superseded");
    expect(getTableByName("deleted_recipe_out")).toBeNull();
    expect((await readdir(tablesDir())).filter((f) => !before.has(f))).toEqual([]);
  }, 180_000);
});

describe("a failed re-run leaves the previous output", () => {
  it("when the fault lands after the replacement began writing", async () => {
    const s = step("SELECT 7 AS n", "survivor_a");
    await startStepRun(testAccountScope(), s.id);
    await laneSettled();
    const goodId = getTableByName("survivor_a")!.id;
    const goodArtifact = getTableByName("survivor_a")!.file;

    // A re-run of the live output — this one really is replacing it.
    editStep(s.id, { sql: SLOW, name: "survivor_a" });
    const before = new Set(await readdir(tablesDir()));
    const job = await startStepRun(testAccountScope(), s.id);
    await untilWriting(before);

    // The fault: the definition moves under a replacement already writing.
    editStep(s.id, { sql: "SELECT 8 AS n", name: "survivor_a" });
    await laneSettled();

    expect(getJob(job.id)!.state).toBe("failed");
    const live = getTableByName("survivor_a")!;
    expect(live.id).toBe(goodId);
    expect(live.file).toBe(goodArtifact);
    expect((await executeQuery(testAccountScope(), "SELECT n FROM survivor_a")).preview[0].n).toBe(7);
  }, 180_000);

  it("when the fault lands between writing and publication", async () => {
    const s = step("SELECT 7 AS n", "survivor_b");
    await startStepRun(testAccountScope(), s.id);
    await laneSettled();
    const good = getTableByName("survivor_b")!;

    // Driven at the materializer, because this is the only place the two
    // moments can be told apart: `authorize` runs at the commit point, with
    // the replacement's artifact fully written and nothing yet swapped.
    let artifactSize = 0;
    await expect(
      materialize(testAccountScope(), {
        sql: "SELECT 9 AS n",
        name: "survivor_b",
        operation: "sql_step",
        replaceTable: { id: good.id, name: good.name },
        authorize: (table) => {
          // Written — and it is not the live one.
          expect(table.file).not.toBe(good.file);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(LostAuthority);

    // The live row still points at yesterday's artifact, with its data.
    const live = getTableByName("survivor_b")!;
    expect(live.id).toBe(good.id);
    expect(live.file).toBe(good.file);
    expect((await executeQuery(testAccountScope(), "SELECT n FROM survivor_b")).preview[0].n).toBe(7);
    artifactSize = (await stat(path.join(dir, "data", live.file))).size;
    expect(artifactSize).toBeGreaterThan(0);
  }, 120_000);
});
