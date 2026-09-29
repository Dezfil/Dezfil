import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

import { createCascade, finishCascade } from "@/lib/metadata/cascades";
const effects = vi.hoisted(() => ({ reads: vi.fn(async () => [] as string[]), engine: vi.fn() }));
vi.mock("@/lib/operations/step-reads", async original => ({ ...await original<typeof import("@/lib/operations/step-reads")>(), stepReads: effects.reads, readsByStep: async (steps: { id: string }[]) => { await effects.reads(); return new Map(steps.map(step => [step.id, []])); } }));
vi.mock("@/lib/duckdb", () => ({ withConnection: effects.engine, trustedH3Ready: vi.fn() }));
let db: Database;
let recipes: Record<string, string>, steps: Record<string, string>;
let runs: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  runs = {}; recipes = {}; steps = {};
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    recipes[account] = createRecipe(scope, `Private ${account}`, db).id;
    steps[account] = addStep(recipes[account], { operation: "sql_step", parameters: { sql: `SELECT '${account}'`, name: "roads" } }, db).id;
    runs[account] = createCascade(recipes[account], "single", [{ stepId: steps[account], ordinal: 0 }], db).id;
    finishCascade(runs[account], "completed", "time", db);

  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  effects.reads.mockClear(); effects.engine.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Workflows", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() { return ["recipes", "recipe_steps", "cascade_runs", "cascade_members", "operation_jobs", "data_tables"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()); }

const cases = [
  ["history", "GET", undefined, () => import("@/app/api/recipes/[id]/runs/route")],
  ["read", "GET", undefined, () => import("@/app/api/recipes/[id]/runs/[runId]/route")],
  ["plan", "POST", { plan: true }, () => import("@/app/api/recipes/[id]/runs/route")],
  ["cancel", "POST", {}, () => import("@/app/api/recipes/[id]/runs/[runId]/cancel/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ id: string; runId: string }> }) => Promise<Response>;
it.each(cases)("refuses hidden workflow %s identically to absence without reading steps", async (_label, method, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method], before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const replies = [];
    for (const [id, runId] of [[recipes[other], runs[other]], ["missing", "missing"]]) replies.push(await handler(input(account, `/api/recipes/${id}/runs`, method, body, kind), { params: Promise.resolve({ id, runId }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json());
    expect(snapshot()).toEqual(before); expect(effects.reads).not.toHaveBeenCalled(); expect(effects.engine).not.toHaveBeenCalled();
  }
});
it.each(["fromStepId", "members"])("rejects mixed workflow %s before parser or job admission", async field => {
  const { POST } = await import("@/app/api/recipes/[id]/runs/route"); const before = snapshot();
  for (const id of [steps.bob, "missing"]) {
    const response = await POST(input("alice", "/api/recipes/r/runs", "POST", { [field]: field === "members" ? [steps.alice, id] : id }), { params: Promise.resolve({ id: recipes.alice }) });
    expect(response.status).toBe(404); expect(effects.reads).not.toHaveBeenCalled(); expect(effects.engine).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  }
});
it.each(["session", "token"])("reads only the %s owner's history and hides mixed parent IDs", async kind => {
  const { GET: list } = await import("@/app/api/recipes/[id]/runs/route");
  const { GET: read } = await import("@/app/api/recipes/[id]/runs/[runId]/route");
  for (const account of accounts) {
    const response = await list(input(account, "/api/recipes/r/runs", "GET", undefined, kind), { params: Promise.resolve({ id: recipes[account] }) });
    expect(response.status).toBe(200); expect((await response.json()).runs.map((r: { id: string }) => r.id)).toEqual([runs[account]]);
    const replies = [];
    for (const runId of [runs[accounts.find(a => a !== account)!], "missing"]) replies.push(await read(input(account, "/api/recipes/r/runs/x", "GET", undefined, kind), { params: Promise.resolve({ id: recipes[account], runId }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json());
  }
});
it("requires authentication before history reads", async () => {
  const { GET } = await import("@/app/api/recipes/[id]/runs/route");
  const anonymous = input("alice", "/api/recipes/r/runs"); anonymous.headers.delete("cookie");
  expect((await GET(anonymous, { params: Promise.resolve({ id: recipes.alice }) })).status).toBe(401);
});
it("filters direct run history before its limit and refuses missing, forged and inactive scopes", async () => {
  const owned = await import("@/lib/metadata/owned-cascades");
  const { readCascade, planCascade } = await import("@/lib/operations/cascade");
  const { startStepRun } = await import("@/lib/operations/step-execution");
  const scope = testAccountScope(db, "alice");
  for (let n = 0; n < 105; n++) createCascade(recipes.bob, "single", [{ stepId: steps.bob, ordinal: 0 }], db);
  expect(owned.listCascades(scope, undefined, db).map(run => run.id)).toEqual([runs.alice]);
  expect(owned.getCascade(scope, runs.bob, db)).toBeNull();
  for (const bad of [undefined, { accountId: "alice" }]) {
    expect(() => owned.listCascades(bad as typeof scope, undefined, db)).toThrow(expect.objectContaining({ status: 401 }));
    await expect(startStepRun(bad as typeof scope, steps.alice)).rejects.toMatchObject({ status: 401 });
  }
  for (const stepId of [steps.bob, "missing"]) await expect(startStepRun(scope, stepId)).rejects.toMatchObject({ status: 404 });
  await expect(startStepRun(scope, steps.alice, { cascadeId: runs.bob })).rejects.toMatchObject({ status: 404 });
  expect(effects.engine).not.toHaveBeenCalled(); expect(effects.reads).not.toHaveBeenCalled();
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect(() => readCascade(scope, runs.alice)).toThrow(expect.objectContaining({ status: 401 }));
  await expect(planCascade(scope, { recipeId: recipes.alice })).rejects.toMatchObject({ status: 401 });
});
it("rejects mixed member creation atomically and validates attempts against their stored parent", async () => {
  const owned = await import("@/lib/metadata/owned-cascades"), before = snapshot(), scope = testAccountScope(db, "alice");
  expect(() => owned.createCascade(scope, recipes.alice, "run_all", [{ stepId: steps.alice, ordinal: 0 }, { stepId: steps.bob, ordinal: 1 }], db)).toThrow(expect.objectContaining({ status: 404 }));
  expect(() => owned.setMember(scope, runs.bob, steps.bob, { state: "failed" }, db)).toThrow(expect.objectContaining({ status: 404 }));
  expect(() => owned.setMember(scope, runs.alice, steps.bob, { state: "failed" }, db)).toThrow(expect.objectContaining({ status: 404 }));
  expect(snapshot()).toEqual(before);
});
it("rechecks account activity after asynchronous planning", async () => {
  const { planCascade } = await import("@/lib/operations/cascade"); const scope = testAccountScope(db, "alice");
  effects.reads.mockImplementationOnce(async () => { db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); return []; });
  await expect(planCascade(scope, { recipeId: recipes.alice })).rejects.toMatchObject({ status: 401 });
});
