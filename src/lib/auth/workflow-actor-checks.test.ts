import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { PERMISSION_REFUSAL, requireCancellable } from "./reach";

/**
 * Who may write to a workflow, its steps and its runs.
 *
 * Pat owns project P; Ada (an editor of P) owns workflow W, filed in P, with
 * steps S and S2, her own run R and a run RE that Ed started; she also owns
 * an unfiled workflow V. Ed is an editor of P, Vi a viewer, Out an admin who
 * belongs to nothing. People rows are written directly: no route adds them yet.
 *
 * Every write asks the reach kernel first: a viewer gets the permission
 * refusal and a non-member the absent refusal, alike across session and token,
 * with nothing changed. Deletion is the owner's. The layout answers with the
 * raw document, so an editor's layout write lands. The routes that answer with
 * the recipe, step or run view stay the owner's for now, since that view is
 * still read in the caller's own space: an editor's write there is refused by
 * the permission shape, before anything is written.
 */
const effects = vi.hoisted(() => ({ reads: vi.fn(async () => [] as string[]), engine: vi.fn() }));
vi.mock("@/lib/operations/step-reads", async original => ({ ...await original<typeof import("@/lib/operations/step-reads")>(), stepReads: effects.reads }));
vi.mock("@/lib/duckdb", () => ({ withConnection: effects.engine, trustedH3Ready: vi.fn() }));

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "ed", "vi", "out"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id)
      VALUES ('W', 'Shared workflow', 'workflow', '${now}', '${now}', 'ada', 'P'), ('V', 'Unfiled workflow', 'workflow', '${now}', '${now}', 'ada', NULL);
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, proposed_parameters, created_at, updated_at)
      VALUES ('S', 'W', 0, 'sql_step', '{"sql":"SELECT 1 AS n","name":"first_out"}', '{"sql":"SELECT 2 AS n","name":"first_out"}', '${now}', '${now}'),
             ('S2', 'W', 1, 'sql_step', '{"sql":"SELECT 3 AS n","name":"second_out"}', NULL, '${now}', '${now}'),
             ('VS', 'V', 0, 'sql_step', '{"sql":"SELECT 1 AS n","name":"other_out"}', '{"sql":"SELECT 2 AS n","name":"other_out"}', '${now}', '${now}'),
             ('VS2', 'V', 1, 'sql_step', '{"sql":"SELECT 3 AS n","name":"other_second"}', NULL, '${now}', '${now}');
    INSERT INTO cascade_runs (id, recipe_id, kind, started_at, initiator_id) VALUES ('R', 'W', 'run_all', '${now}', 'ada'),
      ('RE', 'W', 'run_all', '${now}', 'ed'), ('VR', 'V', 'run_all', '${now}', 'ada');`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, method: string, body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Workflows", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["recipes", "recipe_steps", "recipe_layouts", "cascade_runs", "cascade_members", "operation_jobs", "lineage_edges",
    "step_runner_outputs", "data_tables", "projects", "project_people"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
type Params = { id: string; stepId: string; runId: string };
type Handler = (request: Request, context: { params: Promise<Params> }) => Promise<Response>;
const route = {
  recipe: () => import("@/app/api/recipes/[id]/route"),
  steps: () => import("@/app/api/recipes/[id]/steps/route"),
  step: () => import("@/app/api/recipes/[id]/steps/[stepId]/route"),
  move: () => import("@/app/api/recipes/[id]/steps/[stepId]/move/route"),
  proposal: () => import("@/app/api/recipes/[id]/steps/[stepId]/proposal/route"),
  stepRun: () => import("@/app/api/recipes/[id]/steps/[stepId]/run/route"),
  runs: () => import("@/app/api/recipes/[id]/runs/route"),
  cancel: () => import("@/app/api/recipes/[id]/runs/[runId]/cancel/route"),
  layout: () => import("@/app/api/recipes/[id]/layout/route"),
};
interface Case {
  label: string;
  /** "view": answers with the recipe, step or run view (the owner's for now);
   * "content": an editor's change that answers raw; "owner": the owner's act. */
  kind: "view" | "content" | "owner";
  method: string;
  path: (p: Params) => string;
  body?: unknown;
  load: () => Promise<Record<string, unknown>>;
  params: Params;
  status?: number;
  effect?: () => unknown;
  expected?: unknown;
}
const value = (sql: string) => Object.values(db.prepare(sql).get() as object)[0];
const W = { id: "W", stepId: "S", runId: "R" }, W2 = { id: "W", stepId: "S2", runId: "R" };
const layout = { steps: { S: { x: 10, y: 20 } }, sources: {}, notes: [] };
const cases: Case[] = [
  { label: "rename the workflow", kind: "view", method: "PATCH", path: p => `/api/recipes/${p.id}`, body: { name: "Renamed" }, load: route.recipe,
    params: W, status: 200, effect: () => value("SELECT name FROM recipes WHERE id = 'W'"), expected: "Renamed" },
  { label: "add a step", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/steps`,
    body: { operation: "sql_step", parameters: { sql: "SELECT 4 AS n", name: "added_out" } }, load: route.steps, params: W },
  { label: "edit a step", kind: "view", method: "PATCH", path: p => `/api/recipes/${p.id}/steps/${p.stepId}`,
    body: { parameters: { sql: "SELECT 5 AS n", name: "second_out" } }, load: route.step, params: W2 },
  { label: "remove a step", kind: "view", method: "DELETE", path: p => `/api/recipes/${p.id}/steps/${p.stepId}`, load: route.step, params: W2 },
  { label: "move a step", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/steps/${p.stepId}/move`, body: { ordinal: 0 },
    load: route.move, params: W2 },
  { label: "discard a proposal", kind: "view", method: "DELETE", path: p => `/api/recipes/${p.id}/steps/${p.stepId}/proposal`,
    load: route.proposal, params: W, status: 200, effect: () => value("SELECT proposed_parameters FROM recipe_steps WHERE id = 'S'"), expected: null },
  { label: "run a step", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/steps/${p.stepId}/run`, load: route.stepRun, params: W },
  { label: "run the workflow", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/runs`, body: {}, load: route.runs, params: W },
  { label: "plan a run", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/runs`, body: { plan: true }, load: route.runs, params: W },
  { label: "arrange the canvas", kind: "content", method: "PUT", path: p => `/api/recipes/${p.id}/layout`, body: layout, load: route.layout,
    params: W, status: 200, effect: () => value("SELECT json_extract(document, '$.steps.S.x') FROM recipe_layouts WHERE recipe_id = 'W'"), expected: 10 },
  { label: "delete the workflow", kind: "owner", method: "DELETE", path: p => `/api/recipes/${p.id}`, load: route.recipe, params: W, status: 200,
    effect: () => value("SELECT count(*) FROM recipes WHERE id = 'W'"), expected: 0 },
];
const unfiled = (p: Params): Params => ({ id: "V", stepId: p.stepId === "S" ? "VS" : "VS2", runId: "VR" });
const missing = (p: Params): Params => ({ id: "missing", stepId: p.stepId, runId: p.runId });
async function call(c: Case, account: string, p: Params, kind = "session") {
  const handler = (await c.load())[c.method] as Handler;
  return handler(input(account, c.path(p), c.method, c.body, kind), { params: Promise.resolve(p) });
}
async function refusal(c: Case, account: string, p: Params, absent: Params) {
  const before = snapshot();
  const session = await call(c, account, p), token = await call(c, account, p, "token"), gone = await call(c, account, absent);
  const parsed = { session: { status: session.status, body: await session.json() }, token: { status: token.status, body: await token.json() },
    absent: { status: gone.status, body: await gone.json() } };
  expect(snapshot()).toEqual(before);
  expect(effects.reads).not.toHaveBeenCalled();
  expect(effects.engine).not.toHaveBeenCalled();
  return parsed;
}
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };
const refusedByPermission = (c: Case) => c.kind === "content" ? ["vi"] : ["pat", "ed", "vi"];

describe.each(cases)("$label", c => {
  for (const account of refusedByPermission(c)) {
    it(`refuses ${account} by the permission shape, alike across session and token, with nothing changed`, async () => {
      const { session, token } = await refusal(c, account, c.params, missing(c.params));
      expect(session).toEqual(forbidden);
      expect(token).toEqual(session);
    });
  }
  it("refuses an outsider and an admin by the absent shape, alike across session and token, with nothing changed", async () => {
    const { session, token, absent } = await refusal(c, "out", c.params, missing(c.params));
    expect(session).toEqual({ status: 404, body: absent.body });
    expect(session.body.error.code).toBe("not_found");
    expect(token).toEqual(session);
  });
  it("refuses the project's people on the owner's unfiled workflow by the absent shape", async () => {
    for (const account of ["pat", "ed", "vi"]) {
      const { session, absent } = await refusal(c, account, unfiled(c.params), missing(c.params));
      expect(session).toEqual({ status: 404, body: absent.body });
    }
  });
  if (c.status !== undefined) {
    const permitted = c.kind === "content" ? ["ada", "pat", "ed"] : ["ada"];
    for (const account of permitted) {
      it(`lets ${account} make it`, async () => {
        const response = await call(c, account, c.params);
        expect(response.status, JSON.stringify(await response.clone().json().catch(() => null))).toBe(c.status);
        expect(c.effect?.()).toEqual(c.expected);
      });
    }
  }
});

describe("cancelling a run", () => {
  const cancel: Case = { label: "cancel", kind: "view", method: "POST", path: p => `/api/recipes/${p.id}/runs/${p.runId}/cancel`, load: route.cancel, params: W };
  const run = (runId: string): Params => ({ id: "W", stepId: "S", runId });

  it("is its initiator's or its workflow owner's, a viewer-turned initiator included", () => {
    const allowed = (account: string, runId: string) => {
      try { requireCancellable(testAccountScope(db, account), runId, db); return "allowed"; }
      catch (error) { return (error as { code: string }).code; }
    };
    expect(["ada", "pat", "ed", "vi", "out"].map(account => allowed(account, "R")))
      .toEqual(["allowed", "forbidden", "forbidden", "forbidden", "not_found"]);
    expect(["ada", "pat", "ed", "vi", "out"].map(account => allowed(account, "RE")))
      .toEqual(["allowed", "forbidden", "allowed", "forbidden", "not_found"]);
    db.prepare("UPDATE project_people SET role = 'viewer' WHERE account_id = 'ed'").run();
    expect(allowed("ed", "RE")).toBe("allowed");
    db.prepare("DELETE FROM project_people WHERE account_id = 'ed'").run();
    expect(allowed("ed", "RE")).toBe("not_found");
  });

  it("refuses everyone but the owner on the route while it answers with the run view, the initiator included", async () => {
    for (const [account, runId] of [["pat", "R"], ["ed", "R"], ["vi", "R"], ["ed", "RE"], ["vi", "RE"]]) {
      const { session, token } = await refusal(cancel, account, run(runId), missing(run(runId)));
      expect(session, `${account} ${runId}`).toEqual(forbidden);
      expect(token).toEqual(session);
      expect(value(`SELECT cancelled FROM cascade_runs WHERE id = '${runId}'`)).toBe(0);
    }
    const { session, absent } = await refusal(cancel, "out", run("RE"), missing(run("RE")));
    expect(session).toEqual({ status: 404, body: absent.body });
    const other = await refusal(cancel, "ed", { id: "V", stepId: "VS", runId: "RE" }, missing(run("RE")));
    expect(other.session.status).toBe(404);
  });

  it("lets the owner cancel a run someone else started", async () => {
    const response = await call(cancel, "ada", run("RE"));
    expect(response.status).toBe(200);
    expect(value("SELECT cancelled FROM cascade_runs WHERE id = 'RE'")).toBe(1);
  });
});

describe("the freeze on a deactivated owner's workflow", () => {
  it("refuses the editors' content writes", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    const c = cases.find(entry => entry.kind === "content")!;
    for (const account of ["pat", "ed", "vi"]) {
      const { session, token } = await refusal(c, account, c.params, missing(c.params));
      expect(session).toEqual(forbidden);
      expect(token).toEqual(session);
    }
  });
});
