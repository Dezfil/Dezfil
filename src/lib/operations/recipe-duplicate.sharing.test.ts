import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { listSteps } from "@/lib/metadata/recipes";
import { duplicateRecipe } from "./recipe-duplicate";
import { outputNameRefusal } from "./output-names";

/**
 * A copy's output names, when someone other than the home's account
 * duplicates. The copy keeps the original's SQL home, where its steps read
 * plain names and a declared output shadows a home dataset of the same
 * name; and its runs land in the duplicator's space. So a name the copy
 * takes must be free in both, exactly as the declaration rule requires.
 *
 * Ada owns project P and workflow W, homed in her space and filed in P, with
 * a buffer step declaring `near`. Cyd is an Editor of P. Ada holds a private,
 * unfiled `near_copy`; Cyd holds `near_copy_2`.
 */

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "cyd"]) testAccountScope(db, id);
  shareProject("ada", "P", [["cyd", "editor"]], [], db);
  db.exec(`INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, home_account_id, project_id) VALUES
      ('W', 'Survey', 'workflow', '${now}', '${now}', 'ada', 'ada', 'P');
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, created_at, updated_at) VALUES
      ('S1', 'W', 0, 'buffer', '{"input":"roads","distance":100,"name":"near"}', '${now}', '${now}');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES
      ('DA', 'near_copy', 'geoparquet', 'tables/da.parquet', 1, '${now}', 'ada'),
      ('DC', 'near_copy_2', 'geoparquet', 'tables/dc.parquet', 1, '${now}', 'cyd');`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("a copy's output names against the home it keeps", () => {
  it("never takes a name the home holds, nor one the duplicator holds", async () => {
    const copy = await duplicateRecipe(testAccountScope(db, "cyd"), "W");
    const [step] = listSteps(copy.id, db);
    expect(step.parameters.name).not.toBe("near_copy");
    expect(step.parameters.name).not.toBe("near_copy_2");
    expect(step.parameters.name).toBe("near_copy_3");
  });

  it("allocates a name the declaration rule then accepts for the copy's own steps", async () => {
    const scope = testAccountScope(db, "cyd");
    const copy = await duplicateRecipe(scope, "W");
    const [step] = listSteps(copy.id, db);
    expect(outputNameRefusal({ scope, db, recipeId: copy.id, stepId: step.id, produced: null, typed: step.parameters.name })).toBeNull();
  });

  it("stays as it was for the home's own account", async () => {
    const copy = await duplicateRecipe(testAccountScope(db, "ada"), "W");
    expect(listSteps(copy.id, db)[0].parameters.name).toBe("near_copy_2");
  });
});
