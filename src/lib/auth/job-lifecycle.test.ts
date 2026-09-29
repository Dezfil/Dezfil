import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { readdirSync } from "node:fs";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "./scope";
import { startRun, submitRun, cancelRun } from "@/lib/operations/run";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { getJob, insertJob, listJobs } from "@/lib/metadata/jobs";
import { getOwnedTableByName, listOwnedTables } from "@/lib/metadata/owned-tables";
import { resetQueryInstance } from "@/lib/duckdb";
import { inspectTable } from "@/lib/table-service";
import { recoverInterruptedRuns } from "@/lib/operations/recover";
const measure = vi.hoisted(() => ({ after: undefined as undefined | (() => void) }));
vi.mock("@/lib/ingest/ingest", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/ingest/ingest")>();
  return { ...actual, measureArtifact: async (...args: Parameters<typeof actual.measureArtifact>) => { const value = await actual.measureArtifact(...args); measure.after?.(); return value; } };
});
let dir: string, prior: string | undefined, scopes: Record<string, AccountScope>;
const accounts = ["alice", "bob", "admin"];
beforeEach(async () => {
  prior = process.env.DEZFIL_DATA_DIR; dir = await mkdtemp(path.join(process.cwd(), ".claude/job-life-"));
  process.env.DEZFIL_DATA_DIR = dir; closeMetadataDb(); resetQueryInstance(); resetLane(); measure.after = undefined;
  scopes = Object.fromEntries(accounts.map(account => [account, testAccountScope(metadataDb(), account)]));
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(async () => {
  measure.after = undefined; await laneSettled(); resetLane(); resetQueryInstance(); closeMetadataDb();
  if (prior === undefined) delete process.env.DEZFIL_DATA_DIR; else process.env.DEZFIL_DATA_DIR = prior;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY; delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
  await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});
function request(name: string, value = 1) { return { operation: "sql_step", parameters: { sql: `SELECT ${value} AS value`, name }, subject: "same-subject" }; }
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function files() { try { return await readdir(path.join(dir, "tables")); } catch { return []; } }
it("publishes identical output names for all three owners with distinct durable identities", async () => {
  const ids = new Set<string>();
  for (const [index, account] of accounts.entries()) {
    const job = await startRun(scopes[account], request("same_output", index)); await laneSettled();
    expect(getJob(job.id)?.state).toBe("succeeded"); const table = getOwnedTableByName(scopes[account], "same_output")!;
    expect(table).not.toBeNull(); ids.add(table.id);
    expect((await inspectTable(scopes[account], "same_output")).preview).toEqual([{ value: index }]);
    expect(metadataDb().prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(table.id)).toEqual({ owner_id: account });
    await expect(startRun(scopes[account], request("same_output"))).rejects.toMatchObject({ code: "name_taken" });
  }
  expect(ids.size).toBe(3); expect(await files()).toHaveLength(3);
});
it("does not begin preparation for an account deactivated while queued", async () => {
  process.env.DEZFIL_OPERATION_CONCURRENCY = "1";
  const gate = deferred(), source = vi.fn(async () => ({ sql: "SELECT 2 AS value", disclosure: {}, cleanup: async () => {} }));
  submitRun(scopes.bob, { operationId: "sql_step", name: "blocker", parameters: {}, sql: "", prepare: async () => { await gate.promise; return { sql: "SELECT 1 AS value", disclosure: {}, cleanup: async () => {} }; } });
  const queued = submitRun(scopes.alice, { operationId: "sql_step", name: "never_started", parameters: {}, sql: "", prepare: source });
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  gate.release(); await laneSettled();
  expect(source).not.toHaveBeenCalled(); expect(getJob(queued.id)).toMatchObject({ state: "failed", errorCode: "authentication_required", startedAt: null });
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run(); expect(listOwnedTables(scopes.alice)).toEqual([]);
  expect(getOwnedTableByName(scopes.bob, "blocker")).not.toBeNull();
});
it("removes a completed artifact if the owner loses activity before publication", async () => {
  let completedFiles: string[] = [];
  // The artifact has been measured before the account loses publication access.
  measure.after = () => {
    completedFiles = readdirSync(path.join(dir, "tables"));
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  };
  const job = await startRun(scopes.alice, request("never_published"));
  await laneSettled();
  expect(completedFiles.length).toBeGreaterThan(0); expect(await files()).toEqual([]);
  expect(getJob(job.id)).toMatchObject({ state: "failed", errorCode: "authentication_required" });
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run(); expect(listOwnedTables(scopes.alice)).toEqual([]);
});
it("keeps restart reconciliation and its history cap separate for identical owner subjects", () => {
  process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "2";
  for (const account of accounts) for (let n = 0; n < 4; n++) insertJob(scopes[account], {
    id: `${account}-${n}`, subjectKind: "client", subjectId: "same-subject", operation: "sql_step", parameters: { private: account },
    state: n === 0 ? "succeeded" : "queued", errorCode: null, errorMessage: null, outputId: n === 0 ? `${account}-gone` : null, outputName: n === 0 ? "output" : null,
    acceptedAt: `2026-01-01T00:00:0${n}.000Z`, startedAt: null, finishedAt: n === 0 ? "time" : null,
  });
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect(recoverInterruptedRuns()).toBe(9);
  for (const account of accounts) {
    const rows = listJobs().filter(job => job.parameters?.private === account); expect(rows).toHaveLength(2);
    expect(rows.some(job => job.id === `${account}-0` && job.state === "succeeded")).toBe(true);
    expect(rows.some(job => job.errorCode === "operation_interrupted")).toBe(true);
  }
  expect(recoverInterruptedRuns()).toBe(0);
});
it("cleans preparation after an owned cancellation without changing another owner's job", async () => {
  const gate = deferred(), cleanup = vi.fn(async () => {});
  const own = submitRun(scopes.alice, { operationId: "sql_step", name: "cancelled", parameters: {}, sql: "", prepare: async () => { await gate.promise; return { sql: "SELECT 1 AS value", disclosure: {}, cleanup }; } });
  const other = submitRun(scopes.bob, { operationId: "sql_step", name: "survives", parameters: {}, sql: "SELECT 2 AS value" });
  const cancelling = cancelRun(scopes.alice, own.id); gate.release(); await cancelling; await laneSettled();
  expect(cleanup).toHaveBeenCalledOnce(); expect(getJob(own.id)?.state).toBe("cancelled"); expect(getJob(other.id)?.state).toBe("succeeded");
  expect(listOwnedTables(scopes.alice)).toEqual([]); expect(getOwnedTableByName(scopes.bob, "survives")).not.toBeNull();
});
it.each(["submit", "admit"])("refuses a hidden replacement before %s can start work or mint a job", async boundary => {
  const job = await startRun(scopes.bob, request("bob_output")); await laneSettled();
  const table = getOwnedTableByName(scopes.bob, "bob_output")!, before = listJobs();
  const source = vi.fn(async () => ({ sql: "SELECT 1 AS value", disclosure: {}, cleanup: async () => {} }));
  if (boundary === "submit") expect(() => submitRun(scopes.alice, {
    operationId: "sql_step", name: "bob_output", parameters: {}, sql: "", prepare: source, replaceTable: { id: table.id, name: table.name },
  })).toThrow(expect.objectContaining({ status: 404 }));
  else {
    const { admitOwned } = await import("@/lib/operations/run");
    await expect(admitOwned(scopes.alice, request("bob_output"), { id: table.id, name: table.name })).rejects.toMatchObject({ status: 404 });
  }
  expect(source).not.toHaveBeenCalled(); expect(listJobs()).toEqual(before); expect(getJob(job.id)?.state).toBe("succeeded");
});

it("withholds a cancellation response after owner deactivation while awaiting settlement", async () => {
  const gate = deferred(), cleanup = vi.fn(async () => {});
  const job = submitRun(scopes.alice, { operationId: "sql_step", name: "cancelled", parameters: {}, sql: "", prepare: async () => { await gate.promise; return { sql: "SELECT 1", disclosure: {}, cleanup }; } });
  const cancelling = cancelRun(scopes.alice, job.id);
  const refused = expect(cancelling).rejects.toMatchObject({ status: 401, code: "authentication_required" });
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); gate.release();
  await refused; await laneSettled(); expect(cleanup).toHaveBeenCalledOnce(); expect(getJob(job.id)?.state).toBe("cancelled");
  metadataDb().prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect((await cancelRun(scopes.alice, job.id)).state).toBe("cancelled"); expect(listOwnedTables(scopes.alice)).toEqual([]);
});
