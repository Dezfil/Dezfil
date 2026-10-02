import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { renameRecipe } from "@/lib/metadata/owned-recipes";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { POST as workflowRoute } from "@/app/api/recipes/[id]/runs/route";
import { POST as singleRoute } from "@/app/api/recipes/[id]/steps/[stepId]/run/route";
import { cascadeSettled, planCascade, startCascade, startSingleRun } from "./cascade";
import { buildTools } from "@/lib/tools/tools";
const hooks = vi.hoisted(() => ({ reads: vi.fn(async () => new Map<string, string[]>()), drive: vi.fn(async () => {}), step: vi.fn(async () => ({ id: "job" })) }));
vi.mock("./step-reads", () => ({ readsByStep: hooks.reads }));
vi.mock("./cascade-driver", async original => ({ ...await original<typeof import("./cascade-driver")>(), driveCascade: hooks.drive }));
vi.mock("./step-execution", () => ({ startStepRun: hooks.step }));
let db: Database, id: string, stepId: string;
const scope = () => testAccountScope(db, "ada");
const seen = () => readDocumentRevision({ kind: "workflow", id }, db)!.editRevision!;
const state = () => ["recipes", "recipe_steps", "recipe_layouts", "cascade_runs", "cascade_members", "operation_jobs", "data_tables", "step_runner_outputs"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
const req = (token?: string, body?: unknown, actor = "ada") => testAccountRequest(new Request(`http://instance.test/api/recipes/${id}/runs`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Edit-Revision": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), db, actor);
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); hooks.reads.mockReset().mockResolvedValue(new Map()); hooks.drive.mockClear(); hooks.step.mockClear();
  id = createRecipe(scope(), "Run me", db).id;
  stepId = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "out" } }, db).id;
});
afterEach(async () => { for (const row of db.prepare("SELECT id FROM cascade_runs").all() as { id: string }[]) await cascadeSettled(row.id); vi.restoreAllMocks(); db.close(); });

for (const kind of ["workflow", "single"] as const) it.each([undefined, "bad", "0".repeat(32)])(`${kind} start refuses basis %s before a run or output exists`, async token => {
  const before = state();
  const response = kind === "workflow" ? await workflowRoute(req(token), { params: Promise.resolve({ id }) })
    : await singleRoute(req(token), { params: Promise.resolve({ id, stepId }) });
  expect(response.status).toBe(token === "0".repeat(32) ? 409 : 400);
  if (response.status === 409) expect(await response.json()).toEqual({ error: { code: "stale_revision", message: "This item has changed. Reload it before trying again." } });
  expect(state()).toEqual(before); expect(hooks.drive).not.toHaveBeenCalled(); expect(hooks.step).not.toHaveBeenCalled(); expect(hooks.reads).not.toHaveBeenCalled();
});

it("pairs the plan with the definition read before asynchronous planning, and refuses an old start", async () => {
  const initial = seen();
  hooks.reads.mockImplementationOnce(async () => {
    renameRecipe(scope(), id, "Concurrent rename", db, { expectedRevision: initial }); return new Map();
  });
  const planned = await workflowRoute(req(undefined, { plan: true }), { params: Promise.resolve({ id }) });
  expect(planned.status).toBe(200);
  expect((await planned.json()).editRevision).toBe(initial);
  const before = state();
  await expect(startCascade(scope(), { recipeId: id, expectedRevision: initial })).rejects.toMatchObject({ code: "stale_revision" });
  expect(state()).toEqual(before);
});

it("refuses a change during start planning without replanning or recording anything", async () => {
  const initial = seen(); let accepted: unknown;
  hooks.reads.mockImplementationOnce(async () => {
    renameRecipe(scope(), id, "Changed while planning", db, { expectedRevision: initial }); accepted = state(); return new Map();
  });
  await expect(startCascade(scope(), { recipeId: id, expectedRevision: initial })).rejects.toMatchObject({ code: "stale_revision", status: 409 });
  expect(state()).toEqual(accepted); expect(hooks.reads).toHaveBeenCalledTimes(1); expect(hooks.drive).not.toHaveBeenCalled();
  const fresh = await planCascade(scope(), { recipeId: id });
  const started = await startCascade(scope(), { recipeId: id, expectedRevision: fresh.editRevision });
  await cascadeSettled(started.id); expect(started.recipeId).toBe(id); expect(seen()).toBe(fresh.editRevision);
});

it("requires a basis at both services and accepts the current single-step basis without recording an edit", async () => {
  await expect(startCascade(scope(), { recipeId: id })).rejects.toMatchObject({ status: 400 });
  await expect(startSingleRun(scope(), id, stepId)).rejects.toMatchObject({ status: 400 });
  hooks.step.mockImplementationOnce(async () => {
    db.prepare("INSERT INTO operation_jobs (id, subject_kind, subject_id, operation, state, accepted_at, owner_id) VALUES ('job', 'step', ?, 'sql_step', 'queued', 'time', 'ada')").run(stepId);
    return { id: "job" };
  });
  const basis = seen(); const started = await startSingleRun(scope(), id, stepId, { expectedRevision: basis });
  await cascadeSettled(started.id); expect(started.kind).toBe("single"); expect(started.editRevision).toBe(basis); expect(seen()).toBe(basis);
});

it("keeps unreachable and viewer refusals ahead of revision facts and declares conditional planning", async () => {
  const outsider = await workflowRoute(req(undefined, undefined, "out"), { params: Promise.resolve({ id }) });
  expect(outsider.status).toBe(404); expect(hooks.reads).not.toHaveBeenCalled();
  const tools = buildTools(), run = tools.find(t => t.name === "run_recipe")!, step = tools.find(t => t.name === "run_recipe_step")!;
  expect(run.inputSchema.properties).toHaveProperty("expected_revision");
  expect(run.inputSchema.required ?? []).not.toContain("expected_revision");
  expect(step.inputSchema.required).toContain("expected_revision");
});

it.each(["ada", "eli"])("refuses another editor's same-clock change before start, owner %s", async owner => {
  const editor = owner === "ada" ? "eli" : "ada";
  const { createProject } = await import("@/lib/metadata/owned-projects");
  const { fileRecipe } = await import("@/lib/metadata/projects");
  const owned = testAccountScope(db, owner), shared = testAccountScope(db, editor); testAccountScope(db, "viewer");
  const project = createProject(owned, { name: "Shared" }, db);
  id = createRecipe(owned, "Shared workflow", db).id;
  stepId = addStep(id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "out" } }, db).id;
  fileRecipe(id, project.id, db);
  db.prepare("INSERT INTO project_people VALUES (?, ?, 'editor', 'time'), (?, 'viewer', 'viewer', 'time')").run(project.id, editor, project.id);
  vi.spyOn(Date, "now").mockReturnValue(2000);
  const plan = await planCascade(owned, { recipeId: id });
  renameRecipe(shared, id, "Editor changed it", db, { expectedRevision: plan.editRevision });
  const before = state();
  await expect(startCascade(owned, { recipeId: id, expectedRevision: plan.editRevision })).rejects.toMatchObject({ code: "stale_revision" });
  await expect(startSingleRun(testAccountScope(db, "viewer"), id, stepId)).rejects.toMatchObject({ status: 403 });
  expect(state()).toEqual(before);
  const accepted = await startCascade(owned, { recipeId: id, expectedRevision: seen() });
  await cascadeSettled(accepted.id); expect(accepted.editRevision).toBe(seen());
});

it("admits only one racing start without changing the workflow's revision", async () => {
  const basis = seen();
  const replies = await Promise.allSettled([startCascade(scope(), { recipeId: id, expectedRevision: basis }), startCascade(scope(), { recipeId: id, expectedRevision: basis })]);
  expect(replies.filter(reply => reply.status === "fulfilled")).toHaveLength(1);
  expect(replies.find(reply => reply.status === "rejected")).toMatchObject({ reason: { code: "run_in_flight" } });
  expect(db.prepare("SELECT count(*) AS n FROM cascade_runs").get()).toEqual({ n: 1 }); expect(seen()).toBe(basis);
});
