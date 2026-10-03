import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { afterEach, beforeEach, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { addStep, createRecipe, getStep } from "@/lib/metadata/recipes";
import { editStep } from "@/lib/metadata/owned-recipes";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { getCascade } from "@/lib/metadata/cascades";
import { cascadeSettled, startCascade } from "./cascade";
import { laneSettled, resetLane } from "./lane";

/** Real materialization, paused after COPY wrote its artifact. No clock or
 * scheduler timing decides whether the intervening change preceded commit. */
export function runBasisFixture() {
  const root = process.env.DEZFIL_DATA_DIR!;
  let directory: string, id: string, first: string, second: string;
  let releasePending: (() => void) | undefined;
  const scope = (account = "runner") => testAccountScope(metadataDb(), account);
  const facts = () => readDocumentRevision({ kind: "workflow", id })!;
  const basis = () => ({ expectedRevision: facts().editRevision });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(root, "run-basis-"));
    vi.stubEnv("DEZFIL_DATA_DIR", directory);
    closeMetadataDb(); resetQueryInstance(); resetLane();
    id = createRecipe(scope(), "Workflow").id;
    first = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS n, 'run_basis_hold' AS marker", name: "first" } }).id;
    second = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT n FROM first", name: "second" } }).id;
  });
  afterEach(async () => {
    releasePending?.(); releasePending = undefined;
    await laneSettled();
    vi.restoreAllMocks(); vi.useRealTimers();
    resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const start = (account = "runner") => startCascade(scope(account), { recipeId: id, ...basis() });
  const settle = async (runId: string) => { await cascadeSettled(runId); await laneSettled(); return getCascade(runId)!; };
  const edit = (stepId: string, n: number, origin?: Record<string, unknown> | null) => editStep(scope(), stepId,
    { sql: stepId === first ? `SELECT ${n} AS n, 'run_basis_hold' AS marker` : `SELECT n + ${n} AS n FROM first`, name: stepId === first ? "first" : "second" }, undefined, origin, basis());
  const hold = () => {
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    releasePending = release;
    const original = DuckDBConnection.prototype.run;
    let used = false;
    vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
      const match = !used && sql.startsWith("COPY (") && sql.includes("run_basis_hold");
      if (match) used = true;
      const result = await original.call(this, sql, ...args);
      if (match) { reached(); await released; }
      return result;
    });
    return { release, async reached() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([arrived, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("COPY barrier not reached")), 15_000); })]); }
      finally { clearTimeout(timer); }
    } };
  };
  return { scope, facts, basis, start, settle, edit, hold, get id() { return id; }, get first() { return first; }, get second() { return second; },
    get directory() { return directory; }, step: (stepId: string) => getStep(stepId)!, db: metadataDb };
}
