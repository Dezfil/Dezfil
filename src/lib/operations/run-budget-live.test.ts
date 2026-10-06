import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({ remaining: [] as number[] }));
vi.mock("./materialize", async original => ({ ...await original<typeof import("./materialize")>(),
  materialize: async (_scope: unknown, input: { budgetMs: number; timeoutError: () => Error }) => {
    observed.remaining.push(input.budgetMs); throw input.timeoutError();
  },
}));
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { writeStoredSettings } from "@/lib/settings/store";
import { getJob } from "@/lib/metadata/jobs";
import { submitRun } from "./run";
import { laneSettled, resetLane } from "./lane";
import type { PreparationContext } from "./preparation";

const root = process.env.DEZFIL_DATA_DIR!;
beforeEach(() => {
  closeMetadataDb(); vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "run-budget-")));
  for (const key of ["OPERATION_TIMEOUT_S", "OPERATION_CONCURRENCY"]) vi.stubEnv(`DEZFIL_${key}`, "");
  metadataDb(); observed.remaining.length = 0;
});
afterEach(() => { resetLane(); closeMetadataDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("captures a run budget at execution and carries it and its refusal through preparation", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const scope = testAccountScope(), held = Promise.withResolvers<void>(), entered = Promise.withResolvers<PreparationContext>();
  const prepare = async (context: PreparationContext) => {
    entered.resolve(context); await held.promise;
    return { sql: "SELECT 1", disclosure: {}, cleanup: async () => {} };
  };
  const first = submitRun(scope, { operationId: "sql_step", parameters: {}, sql: "SELECT 1", name: "first", prepare });
  const context = await entered.promise;
  const second = submitRun(scope, { operationId: "sql_step", parameters: {}, sql: "SELECT 1", name: "second" });
  try {
    expect(context.deadlineAt - now).toBe(600_000);
    writeStoredSettings({ operationTimeoutS: 80 }, metadataDb()); now += 20_000;
    expect(context.timeoutError().message).toContain("600s execution budget");
  } finally { held.resolve(); await laneSettled(); }
  expect(observed.remaining).toEqual([580_000, 80_000]);
  expect(getJob(first.id)!.errorMessage).toContain("600s execution budget");
  expect(getJob(second.id)!.errorMessage).toContain("80s execution budget");
});
