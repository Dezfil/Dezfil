import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { createRecipe, addStep as seedStep } from "@/lib/metadata/recipes";
import { renameRecipe } from "@/lib/metadata/owned-recipes";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { PATCH as rename, DELETE as remove } from "@/app/api/recipes/[id]/route";
import { POST as add } from "@/app/api/recipes/[id]/steps/route";
import { PATCH as edit, DELETE as detach } from "@/app/api/recipes/[id]/steps/[stepId]/route";
import { POST as move } from "@/app/api/recipes/[id]/steps/[stepId]/move/route";
import { DELETE as discard } from "@/app/api/recipes/[id]/steps/[stepId]/proposal/route";
import { PUT as layout } from "@/app/api/recipes/[id]/layout/route";
import { buildTools } from "@/lib/tools/tools";
const reads = vi.hoisted(() => ({ step: vi.fn(async () => [] as string[]) }));
vi.mock("./step-reads", () => ({ stepReads: reads.step, readsByStep: async () => new Map() }));
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); reads.step.mockReset().mockResolvedValue([]); db.close(); });
const revision = (id: string) => readDocumentRevision({ kind: "workflow", id }, db)!.editRevision!;
const snapshot = () => ["recipes", "recipe_steps", "recipe_layouts", "cascade_runs", "data_tables"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
function fixture() {
  const scope = testAccountScope(db), recipe = createRecipe(scope, "Workflow", db);
  const step = seedStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "out" } }, db);
  return { scope, recipe, step };
}
function request(method: string, body: unknown, basis?: string, account = "test-account") {
  return testAccountRequest(new Request("http://instance.test/api/recipes/fixture", { method,
    headers: { "content-type": "application/json", ...(basis === undefined ? {} : { "X-Edit-Revision": basis }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
}
it.each([undefined, "bad", "stale"])("refuses %s workflow bases across definition, steps and layout with complete rollback", async basis => {
  const { scope, recipe, step } = fixture(), seen = revision(recipe.id);
  renameRecipe(scope, recipe.id, "Other tab", db, { expectedRevision: seen });
  const expected = basis === "stale" ? seen : basis;
  const context = { params: Promise.resolve({ id: recipe.id, stepId: step.id }) };
  for (const [handler, method, body] of [
    [rename, "PATCH", { name: "Refused" }], [add, "POST", { operation: "sql_step", parameters: { sql: "SELECT 2", name: "second" } }],
    [edit, "PATCH", { parameters: { sql: "SELECT 3", name: "out" } }], [move, "POST", { ordinal: 0 }],
    [discard, "DELETE", undefined], [detach, "DELETE", undefined], [layout, "PUT", { steps: {}, sources: [], notes: [] }], [remove, "DELETE", undefined],
  ] as const) {
    const before = snapshot();
    const response = await handler(request(method, body, expected), context);
    expect(response.status).toBe(basis === "stale" ? 409 : 400);
    expect(await response.json()).toEqual({ error: basis === "stale"
      ? { code: "stale_revision", message: "This item has changed. Reload it before trying again." }
      : { code: "invalid_request", message: "Read this item first, then send its editRevision in X-Edit-Revision." } });
    expect(snapshot()).toEqual(before);
  }
});
it("compares again after asynchronous step validation and permits a deliberate fresh edit", async () => {
  const { scope, recipe, step } = fixture(), seen = revision(recipe.id);
  const context = { params: Promise.resolve({ id: recipe.id, stepId: step.id }) };
  let accepted: unknown;
  reads.step.mockImplementationOnce(async () => {
    renameRecipe(scope, recipe.id, "Changed during validation", db, { expectedRevision: seen });
    accepted = snapshot(); return [];
  });
  const body = { parameters: { sql: "SELECT 2", name: "out" } };
  expect((await edit(request("PATCH", body, seen), context)).status).toBe(409);
  expect(snapshot()).toEqual(accepted);
  const response = await edit(request("PATCH", body, revision(recipe.id)), context);
  expect(response.status).toBe(200);
  expect((await response.json()).editRevision).toBe(revision(recipe.id));
});
it("requires a service basis and preserves permission precedence and the declared tool inputs", async () => {
  const { scope, recipe, step } = fixture();
  expect(() => renameRecipe(scope, recipe.id, "Refused", db)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  const response = await edit(request("PATCH", { parameters: {} }, undefined, "outsider"), { params: Promise.resolve({ id: recipe.id, stepId: step.id }) });
  expect(response.status).toBe(404);
  for (const name of ["update_recipe", "delete_recipe", "set_recipe_layout", "add_recipe_step", "update_recipe_step", "remove_recipe_step", "move_recipe_step", "discard_recipe_step_edit"]) {
    expect(buildTools().find(tool => tool.name === name)!.inputSchema.required, name).toContain("expected_revision");
  }
});

it.each(["ada", "eli"])("uses one revision for owner %s and their Editor, including layout and same-clock changes", async owner => {
  const { createProject } = await import("@/lib/metadata/owned-projects");
  const { writeLayout } = await import("./recipe-layout");
  const editor = owner === "ada" ? "eli" : "ada";
  const scopes = { ada: testAccountScope(db, "ada"), eli: testAccountScope(db, "eli"), viewer: testAccountScope(db, "viewer") };
  const recipe = createRecipe(scopes[owner as "ada" | "eli"], "Shared", db);
  const project = createProject(scopes[owner as "ada" | "eli"], { name: "Project", members: { addRecipes: [recipe.id] } }, db);
  for (const [account, role] of [[editor, "editor"], ["viewer", "viewer"]]) db.prepare("INSERT INTO project_people VALUES (?, ?, ?, ?)").run(project.id, account, role, new Date().toISOString());
  const seen = revision(recipe.id);
  vi.spyOn(Date, "now").mockReturnValue(1234567890000);
  renameRecipe(scopes[editor], recipe.id, "Editor renamed", db, { expectedRevision: seen });
  const before = snapshot();
  expect(() => writeLayout(scopes[owner as "ada" | "eli"], recipe.id, { steps: {}, sources: {}, notes: [] }, db, { expectedRevision: seen })).toThrow(expect.objectContaining({ code: "stale_revision" }));
  expect(snapshot()).toEqual(before);
  expect(() => renameRecipe(scopes.viewer, recipe.id, "Viewer", db)).toThrow(expect.objectContaining({ code: "forbidden" }));
  const fresh = revision(recipe.id);
  writeLayout(scopes[owner as "ada" | "eli"], recipe.id, { steps: {}, sources: {}, notes: [] }, db, { expectedRevision: fresh });
  expect(revision(recipe.id)).toBe(fresh);
  expect(readDocumentRevision({ kind: "workflow", id: recipe.id }, db)!.lastChangedBy).toBe(editor);
});
