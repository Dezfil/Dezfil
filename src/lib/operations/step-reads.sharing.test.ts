import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import { resetLane } from "@/lib/operations/lane";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { fileDataset, shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "@/lib/auth/scope";
import { stepReads } from "./step-reads";

/**
 * A SQL step's reads as written, qualified ones included. Ada's workflow, in
 * project P where Bob is an Editor, reads her `roads` by its plain name and
 * Bob's `roads`, filed in P, as `bob.roads`. The step's view must name both
 * reads, the external one qualified, as the named-input verbs already do;
 * a qualified read of a dataset nobody reaches is named too, and makes the
 * step unable to run. Neither person's view drops a read.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let ids: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "step-reads-sharing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const owner of ["ada", "bob"]) {
    const file = path.join(directory, `${owner}-roads.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} roads,1,2\n`);
    tables[owner] = await ingestFile(scopes[owner], file, "roads.csv");
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables.ada.id]);
  fileDataset("P", tables.bob.id);
  const recipe = createRecipe(scopes.ada, "Survey");
  fileRecipe(recipe.id, "P");
  ids = {
    recipe: recipe.id,
    both: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads UNION ALL SELECT * FROM bob.roads", name: "both" } }).id,
    his: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM Bob.Roads", name: "his" } }).id,
    gone: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM bob.rivers", name: "gone" } }).id,
  };
});
afterEach(async () => { resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type StepWire = { id: string; reads: string[]; conditions: string[]; missingInputs: { tableName: string }[] };
async function view(account: string): Promise<(key: string) => StepWire> {
  const { GET } = await import("@/app/api/recipes/[id]/route");
  const request = testAccountRequest(new Request(`http://instance.test/api/recipes/${ids.recipe}`), undefined, account);
  const response = await GET(request, { params: Promise.resolve({ id: ids.recipe }) });
  expect(response.status, account).toBe(200);
  const steps = ((await response.json()) as { recipe: { steps: StepWire[] } }).recipe.steps;
  return (key) => steps.find((s) => s.id === ids[key])!;
}

describe("a SQL step's reads", () => {
  it("names a qualified external read beside the plain ones, as the step writes it", async () => {
    const reads = await stepReads(scopes.ada, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads UNION ALL SELECT * FROM bob.roads" }, proposedParameters: null });
    expect(reads).toEqual(["roads", "bob.roads"]);
    // One read, however often or however cased it is written.
    const twice = await stepReads(scopes.ada, { operation: "sql_step", parameters: { sql: "SELECT * FROM bob.roads JOIN Bob.Roads USING (sentinel)" }, proposedParameters: null });
    expect(twice).toEqual(["bob.roads"]);
  });

  for (const account of ["ada", "bob"]) {
    it(`keeps every read in the workflow's view for ${account}`, async () => {
      const step = await view(account);
      expect(step("both").reads).toEqual(["roads", "bob.roads"]);
      expect(step("his").reads).toEqual(["bob.roads"]);
      // Both reach Bob's roads: a reachable qualified read breaks nothing.
      expect(step("his").conditions).not.toContain("broken");
      // A qualified read nobody reaches is named and makes the step unable to run.
      expect(step("gone").reads).toEqual(["bob.rivers"]);
      expect(step("gone").conditions).toContain("broken");
      expect(step("gone").missingInputs.map((m) => m.tableName)).toEqual(["bob.rivers"]);
    });
  }
});
