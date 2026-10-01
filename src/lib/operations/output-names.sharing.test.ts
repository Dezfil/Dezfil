import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { outputNameRefusal } from "./output-names";

/**
 * A declared output's name on a shared workflow. Its SQL binds in the
 * workflow's home, where a declared output shadows a home dataset of the same
 * name for every step that reads it; and a run's output lands in its runner's
 * own space. So a name is taken when the home holds a dataset of that name,
 * whoever declares it, and when the person declaring it holds one, since
 * their run would land it there.
 *
 * Ada owns project P and workflow W, homed in her space and filed in P; Bo is
 * an Editor of P. Ada holds `parcels` (private, unfiled); Bo holds
 * `stations`. Workflow T was Ada's and is Bo's now: its home stays Ada's.
 */

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "bo"]) testAccountScope(db, id);
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'ada');
    INSERT INTO project_people VALUES ('P', 'bo', 'editor', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, home_account_id, project_id) VALUES
      ('W', 'Shared workflow', 'workflow', '${now}', '${now}', 'ada', 'ada', 'P'),
      ('T', 'Handed over', 'workflow', '${now}', '${now}', 'bo', 'ada', 'P');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES
      ('DA', 'parcels', 'geoparquet', 'tables/da.parquet', 1, '${now}', 'ada'),
      ('DB', 'stations', 'geoparquet', 'tables/db.parquet', 1, '${now}', 'bo');`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const refusal = (account: string, recipeId: string, typed: string) =>
  outputNameRefusal({ scope: testAccountScope(db, account), db, recipeId, stepId: null, produced: null, typed });

describe("a declared output's name on a shared workflow", () => {
  it("is taken for an Editor when the workflow's home holds a dataset of that name", () => {
    const answer = refusal("bo", "W", "parcels");
    expect(answer?.code).toBe("name_taken");
    expect(answer?.message).toContain('"parcels"');
  });

  it("is taken for an Editor when their own space, where the run lands it, holds one", () => {
    expect(refusal("bo", "W", "stations")?.code).toBe("name_taken");
  });

  it("is free for an Editor when neither holds one", () => {
    expect(refusal("bo", "W", "fresh_output")).toBeNull();
  });

  it("stays as it was for the owner in their own home: their datasets, not an Editor's", () => {
    expect(refusal("ada", "W", "parcels")?.code).toBe("name_taken");
    expect(refusal("ada", "W", "stations")).toBeNull();
  });

  it("follows the home, not the owner, on a workflow handed to someone else", () => {
    expect(refusal("bo", "T", "parcels")?.code).toBe("name_taken");
    expect(refusal("bo", "T", "stations")?.code).toBe("name_taken");
    expect(refusal("ada", "T", "stations")).toBeNull();
  });
});
