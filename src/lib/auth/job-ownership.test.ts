import { getJob, listJobs } from "@/lib/metadata/owned-jobs";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { insertJob, type JobQuery, type OperationJob } from "@/lib/metadata/jobs";
import { cancelRun, prune } from "@/lib/operations/run";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import type { AccountScope } from "./scope";

const effects = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/lib/operations/lane", () => ({ cancel: effects.cancel, jobSettled: async () => {} }));
let db: Database, scopes: Record<string, AccountScope>;
const accounts = ["alice", "bob", "admin"];
function record(account: string, state: OperationJob["state"] = "queued", n = 0): OperationJob {
  return { id: `${account}-${state}-${n}`, subjectKind: "client", subjectId: "same-subject", operation: "sql_step", parameters: { private: account }, state,
    errorCode: state === "failed" ? "sql_error" : null, errorMessage: state === "failed" ? `private-${account}` : null,
    outputId: state === "succeeded" ? `${account}-deleted-output` : null, outputName: state === "succeeded" ? "same-name" : null,
    acceptedAt: `2026-01-01T00:00:0${n}.000Z`, startedAt: state === "queued" ? null : "time", finishedAt: ["queued", "running"].includes(state) ? null : "time" };
}
function ownRead(scope: AccountScope, id: string) { return getJob(scope, id, db); }
function ownList(scope: AccountScope, query: JobQuery = {}) { return listJobs(scope, query, db); }
function ownCancel(scope: AccountScope, id: string) { return cancelRun(scope, id); }
function ownPrune(scope: AccountScope) { return prune(scope, "same-subject", "client"); }
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); scopes = {};
  for (const account of accounts) {
    scopes[account] = testAccountScope(db, account);
    for (const state of ["queued", "running", "succeeded", "failed", "cancelled"] as const) insertJob(scopes[account], record(account, state), db);
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run(); effects.cancel.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT; });
function request(account: string, kind: string, method = "GET") {
  const req = testAccountRequest(new Request("http://instance.test/api/operations/runs?subject=same-subject&limit=2", { method }), db, account);
  if (kind === "token") { const token = createApiToken(requireRequestAuth(req, db), "Jobs", db); req.headers.delete("cookie"); req.headers.set("authorization", `Bearer ${token.secret}`); }
  return req;
}
it.each(["session", "token"])("filters %s history by owner before subject grouping, pagination and decoding", async kind => {
  const { GET } = await import("@/app/api/operations/runs/route");
  for (const account of accounts) {
    const response = await GET(request(account, kind)); expect(response.status).toBe(200);
    const runs = (await response.json()).runs as { parameters: { private: string } }[];
    expect(runs).toHaveLength(2); expect(runs.every(run => run.parameters.private === account)).toBe(true);
  }
  db.prepare("UPDATE operation_jobs SET parameters = 'private-invalid-json' WHERE owner_id = 'bob'").run();
  expect((await GET(request("alice", kind))).status).toBe(200);
});
it.each(["queued", "running", "succeeded", "failed", "cancelled"] as const)("refuses hidden %s jobs and cancellation like absence, independently of outputs", async state => {
  const read = await import("@/app/api/operations/runs/[id]/route"), cancel = await import("@/app/api/operations/runs/[id]/cancel/route");
  const before = db.prepare("SELECT * FROM operation_jobs ORDER BY id").all();
  for (const account of accounts) for (const kind of ["session", "token"]) {
    const other = accounts.find(a => a !== account)!;
    for (const [handler, method] of [[read.GET, "GET"], [cancel.POST, "POST"]] as const) {
      const hidden = await handler(request(account, kind, method), { params: Promise.resolve({ id: record(other, state).id }) });
      const missing = await handler(request(account, kind, method), { params: Promise.resolve({ id: "missing" }) });
      expect([hidden.status, missing.status]).toEqual([404, 404]); expect(await hidden.json()).toEqual(await missing.json());
    }
  }
  expect(db.prepare("SELECT * FROM operation_jobs ORDER BY id").all()).toEqual(before); expect(effects.cancel).not.toHaveBeenCalled();
});
it("protects direct job reads, lists and cancellation for every account", async () => {
  for (const account of accounts) {
    expect(ownList(scopes[account]).every(job => job.parameters?.private === account)).toBe(true);
    const other = accounts.find(a => a !== account)!;
    expect(ownRead(scopes[account], record(other).id)).toBeNull();
    for (const id of [record(other).id, "missing"]) await expect(ownCancel(scopes[account], id)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(ownRead(scopes[account], record(account, "succeeded").id)?.outputId).toBe(`${account}-deleted-output`);
  }
});
it("keeps identical subjects and pruning budgets independent between owners", () => {
  process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "2";
  for (const account of accounts) for (let n = 1; n < 5; n++) insertJob(scopes[account], record(account, "failed", n), db);
  const otherBefore = db.prepare("SELECT * FROM operation_jobs WHERE owner_id <> 'alice' ORDER BY id").all();
  ownPrune(scopes.alice);
  expect(db.prepare("SELECT * FROM operation_jobs WHERE owner_id <> 'alice' ORDER BY id").all()).toEqual(otherBefore);
  expect(ownList(scopes.alice).filter(job => !["queued", "running"].includes(job.state))).toHaveLength(2);
  expect(ownRead(scopes.alice, record("alice", "succeeded").id)).not.toBeNull();
});
it("requires genuine active account scope for history and cancellation", async () => {
  for (const scope of [undefined, { accountId: "alice" }] as unknown as AccountScope[]) {
    expect(() => ownRead(scope, record("alice").id)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => ownList(scope)).toThrow(expect.objectContaining({ status: 401 }));
    await expect(ownCancel(scope, record("alice").id)).rejects.toMatchObject({ status: 401 });
  }
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect(() => ownList(scopes.alice)).toThrow(expect.objectContaining({ status: 401 }));
});
it("refuses a foreign or missing contained subject before job insertion", async () => {
  const { createRecipe, addStep } = await import("@/lib/metadata/recipes");
  const { submitRun } = await import("@/lib/operations/run");
  const recipe = createRecipe(scopes.bob, "Private", db), step = addStep(recipe.id, { operation: "sql_step", parameters: {} }, db);
  const before = db.prepare("SELECT * FROM operation_jobs ORDER BY id").all();
  for (const subject of [step.id, "missing"]) expect(() => submitRun(scopes.alice, { operationId: "sql_step", name: "new_output", sql: "SELECT 1", parameters: {}, subjectKind: "step", subject }))
    .toThrow(expect.objectContaining({ status: 404, code: "not_found" }));
  expect(db.prepare("SELECT * FROM operation_jobs ORDER BY id").all()).toEqual(before);
});
it("scopes direct worker transitions and deletion to the recorded initiator", async () => {
  const jobs = await import("@/lib/metadata/owned-jobs");
  const before = db.prepare("SELECT * FROM operation_jobs ORDER BY id").all();
  for (const account of accounts) for (const id of [record(accounts.find(a => a !== account)!).id, "missing"]) {
    expect(jobs.markRunning(scopes[account], id, "now", db)).toBe(false);
    expect(jobs.finish(scopes[account], id, { state: "cancelled" }, "now", db)).toBe(false);
    expect(jobs.deleteJob(scopes[account], id, db)).toBe(false);
  }
  expect(db.prepare("SELECT * FROM operation_jobs ORDER BY id").all()).toEqual(before);
});
it("rejects anonymous history, result and cancellation adapters", async () => {
  const { socketRequest } = await import("@/lib/assistant/testing/socket-request");
  const list = await import("@/app/api/operations/runs/route"), read = await import("@/app/api/operations/runs/[id]/route"), cancel = await import("@/app/api/operations/runs/[id]/cancel/route");
  const req = () => socketRequest(new Request("http://instance.test/api/operations/runs"));
  expect((await list.GET(req())).status).toBe(401);
  expect((await read.GET(req(), { params: Promise.resolve({ id: record("alice").id }) })).status).toBe(401);
  expect((await cancel.POST(req(), { params: Promise.resolve({ id: record("alice").id }) })).status).toBe(401);
});
