import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { ApiError } from "@/lib/api/errors";
import {
  getTableByName,
  insertTable,
  deleteTable,
  type DataTable,
} from "@/lib/metadata/tables";
import {
  createRecipe,
  addStep,
  getStep,
  editStep,
  recordOutput,
  removeStep,
  type RecipeStep,
} from "@/lib/metadata/recipes";
import { edgesForStep } from "@/lib/metadata/lineage";
import { planPublication, stepAuthorizer } from "./step-run";

let dir: string;
let recipeId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined, { scope: testAccountScope() });
  recipeId = createRecipe(testAccountScope(), "R").id;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const newStep = () =>
  addStep(recipeId, {
    operation: "sql_step",
    parameters: { sql: "SELECT 1 AS n", name: "out" },
  });

/** Register a table directly, standing in for a run's output. */
function seedTable(id: string, name: string, file = `tables/${id}.parquet`): DataTable {
  const t: DataTable = {
    id,
    name,
    sourceFilename: null,
    format: "geoparquet",
    file,
    geometryColumn: null,
    geometryType: null,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 1,
    createdAt: new Date().toISOString(),
    source: "operation",
    sourceParams: null,
    importedAt: new Date().toISOString(),
  };
  insertTable(testAccountScope(), t);
  return t;
}

const alwaysFinishes = () => true;

describe("planning how a step publishes", () => {
  it("registers afresh for a step that has never produced anything", () => {
    const plan = planPublication(testAccountScope(), newStep().id);
    expect(plan.replaceTable).toBeUndefined();
    expect(plan.isProposal).toBe(false);
  });

  it("replaces in place when the step still owns its output", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());

    const plan = planPublication(testAccountScope(), step.id);
    expect(plan.replaceTable).toEqual({ id: "t1", name: "out" });
  });

  it("registers afresh — with a new id — when the output was deleted", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    deleteTable("out");

    const plan = planPublication(testAccountScope(), step.id);
    // A deleted table's id is gone; pretending to restore it would be
    // inventing identity.
    expect(plan.replaceTable).toBeUndefined();
  });

  it("refuses when the name now belongs to a different table", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    deleteTable("out");
    seedTable("usurper", "out");

    try {
      planPublication(testAccountScope(), step.id);
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("name_taken");
    }
  });

  it("runs the proposal when there is one, without promoting it yet", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    editStep(step.id, { sql: "SELECT 2 AS n", name: "out" });

    const plan = planPublication(testAccountScope(), step.id);
    expect(plan.isProposal).toBe(true);
    expect(plan.running).toEqual({ sql: "SELECT 2 AS n", name: "out" });
    // And the step still means what its output was produced from.
    expect(getStep(step.id)!.parameters).toEqual({ sql: "SELECT 1 AS n", name: "out" });
  });

  it("answers not_found for a step that does not exist", () => {
    expect(() => planPublication(testAccountScope(), "nope")).toThrow(ApiError);
  });
});

describe("the authority callback", () => {
  const inputs = [{ id: "src", name: "stations", artifact: "tables/src@1.parquet" }];

  it("records ownership and lineage together", () => {
    const step = newStep();
    const plan = planPublication(testAccountScope(), step.id);

    const ok = stepAuthorizer(testAccountScope(), plan, alwaysFinishes)(
      { id: "new-1", name: "out" },
      metadataDb(),
      inputs,
    );

    expect(ok).toBe(true);
    expect(getStep(step.id)!.outputTableId).toBe("new-1");
    const edges = edgesForStep(testAccountScope(), step.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].boundArtifact).toBe("tables/src@1.parquet");
  });

  it("promotes a proposal only on success", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    editStep(step.id, { sql: "SELECT 2 AS n", name: "out" });
    const plan = planPublication(testAccountScope(), step.id);

    stepAuthorizer(testAccountScope(), plan, alwaysFinishes)({ id: "t1", name: "out" }, metadataDb(), inputs);

    const after = getStep(step.id)!;
    expect(after.parameters).toEqual({ sql: "SELECT 2 AS n", name: "out" });
    expect(after.proposedParameters).toBeNull();
  });

  it("refuses when the step was deleted while the run worked (E10's fence)", () => {
    const step = newStep();
    const plan = planPublication(testAccountScope(), step.id);
    removeStep(step.id);

    expect(
      stepAuthorizer(testAccountScope(), plan, alwaysFinishes)({ id: "x", name: "out" }, metadataDb(), inputs),
    ).toBe(false);
  });

  it("refuses when a proposal superseded the definition mid-run", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    const plan = planPublication(testAccountScope(), step.id);

    // Someone edits the step while this run is working.
    editStep(step.id, { sql: "SELECT 99 AS n", name: "out" });

    expect(
      stepAuthorizer(testAccountScope(), plan, alwaysFinishes)({ id: "t1", name: "out" }, metadataDb(), inputs),
    ).toBe(false);
  });

  it("refuses a replacement whose ownership has gone", () => {
    const step = newStep();
    seedTable("t1", "out");
    recordOutput(step.id, { id: "t1", name: "out" }, new Date().toISOString());
    const plan = planPublication(testAccountScope(), step.id);
    expect(plan.replaceTable).toBeDefined();

    // The step's recorded output changes under the run — it no longer owns t1.
    recordOutput(step.id, { id: "t2", name: "other" }, new Date().toISOString());

    expect(
      stepAuthorizer(testAccountScope(), plan, alwaysFinishes)({ id: "t1", name: "out" }, metadataDb(), inputs),
    ).toBe(false);
  });

  it("refuses when the job itself could not be settled", () => {
    const step = newStep();
    const plan = planPublication(testAccountScope(), step.id);

    // The job was cancelled: its terminal write refuses, and so must this.
    const ok = stepAuthorizer(testAccountScope(), plan, () => false)(
      { id: "x", name: "out" },
      metadataDb(),
      inputs,
    );

    expect(ok).toBe(false);
    // And nothing was recorded on the step.
    expect(getStep(step.id)!.outputTableId).toBeNull();
    expect(edgesForStep(testAccountScope(), step.id)).toEqual([]);
  });

  it("replaces a step's edges rather than adding to them", () => {
    const step = newStep();
    const plan = planPublication(testAccountScope(), step.id);
    const authorize = stepAuthorizer(testAccountScope(), plan, alwaysFinishes);

    authorize({ id: "out-1", name: "out" }, metadataDb(), [
      { id: "a", name: "alpha", artifact: "tables/a@1.parquet" },
    ]);
    authorize({ id: "out-1", name: "out" }, metadataDb(), [
      { id: "b", name: "beta", artifact: "tables/b@1.parquet" },
    ]);

    const edges = edgesForStep(testAccountScope(), step.id);
    expect(edges.map((e) => e.inputTableId)).toEqual(["b"]);
  });
});

/** Ownership can only come from the stored row — the forgery guard. */
describe("ownership is not forgeable", () => {
  it("a step cannot replace a table it does not own", () => {
    const mine = newStep();
    const theirs: RecipeStep = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1", name: "theirs" },
    });
    seedTable("t-theirs", "theirs");
    recordOutput(theirs.id, { id: "t-theirs", name: "theirs" }, new Date().toISOString());

    // My step has produced nothing, so it plans a fresh registration — it
    // cannot nominate someone else's table as its replacement target.
    const plan = planPublication(testAccountScope(), mine.id);
    expect(plan.replaceTable).toBeUndefined();

    // And forcing one in is refused by the stored-ownership check.
    const forged = { ...plan, replaceTable: { id: "t-theirs", name: "theirs" } };
    expect(
      stepAuthorizer(testAccountScope(), forged, alwaysFinishes)(
        { id: "t-theirs", name: "theirs" },
        metadataDb(),
        [],
      ),
    ).toBe(false);
    // Their table is untouched.
    expect(getTableByName("theirs")!.id).toBe("t-theirs");
  });
});
