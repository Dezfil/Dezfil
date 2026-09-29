import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { createProject } from "@/lib/metadata/projects";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

const effects = vi.hoisted(() => ({ reads: vi.fn(async () => [] as string[]), engine: vi.fn() }));
vi.mock("@/lib/operations/step-reads", async original => ({ ...await original<typeof import("@/lib/operations/step-reads")>(), stepReads: effects.reads }));
vi.mock("@/lib/duckdb", () => ({ withConnection: effects.engine, trustedH3Ready: vi.fn() }));
let db: Database;
let recipes: Record<string, string>, steps: Record<string, string>, projects: Record<string, string>, layers: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  recipes = {}; steps = {}; projects = {}; layers = {};
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    recipes[account] = createRecipe(scope, `Private ${account}`, db).id;
    steps[account] = addStep(recipes[account], { operation: "sql_step", parameters: { sql: `SELECT '${account}'`, name: "roads" } }, db).id;
    projects[account] = createProject(scope, { name: `Private ${account}` }, db).id;
    const map = createMap(scope, "Private map");
    layers[account] = `layer-${account}`;
    db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, 'Private layer', ?, ?, 0, 'time', 'time')`).run(layers[account], map.id, `SELECT '${account}'`, JSON.stringify(defaultStyle(null)));
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
function snapshot() { return ["recipes", "recipe_steps", "recipe_layouts", "data_tables", "projects"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()); }
const cases = [
  ["read", "GET", undefined, () => import("@/app/api/recipes/[id]/route")],
  ["rename", "PATCH", { name: "Changed" }, () => import("@/app/api/recipes/[id]/route")],
  ["delete", "DELETE", undefined, () => import("@/app/api/recipes/[id]/route")],
  ["duplicate", "POST", {}, () => import("@/app/api/recipes/[id]/duplicate/route")],
  ["read layout", "GET", undefined, () => import("@/app/api/recipes/[id]/layout/route")],
  ["write layout", "PUT", { notes: [] }, () => import("@/app/api/recipes/[id]/layout/route")],
  ["add step", "POST", { operation: "sql_step", parameters: { sql: "SELECT 1", name: "fresh" } }, () => import("@/app/api/recipes/[id]/steps/route")],
  ["dependencies", "GET", undefined, () => import("@/app/api/recipes/[id]/dependencies/route")],
] as const;
const childCases = [
  ["read", "GET", undefined, () => import("@/app/api/recipes/[id]/steps/[stepId]/route")],
  ["edit", "PATCH", { parameters: { sql: "SELECT 2", name: "roads" } }, () => import("@/app/api/recipes/[id]/steps/[stepId]/route")],
  ["remove", "DELETE", undefined, () => import("@/app/api/recipes/[id]/steps/[stepId]/route")],
  ["discard proposal", "DELETE", undefined, () => import("@/app/api/recipes/[id]/steps/[stepId]/proposal/route")],
  ["move", "POST", { ordinal: 0 }, () => import("@/app/api/recipes/[id]/steps/[stepId]/move/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ id: string; stepId: string }> }) => Promise<Response>;
it.each(cases)("refuses hidden workflow %s before reading contents or doing work", async (_label, method, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method], before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const replies = [];
    for (const id of [recipes[other], "missing"]) replies.push(await handler(input(account, `/api/recipes/${id}`, method, body, kind), { params: Promise.resolve({ id, stepId: steps[other] }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json());
    expect(snapshot()).toEqual(before); expect(effects.reads).not.toHaveBeenCalled(); expect(effects.engine).not.toHaveBeenCalled();
  }
});
it.each(childCases)("refuses hidden and mixed-parent step %s exactly like absence", async (_label, method, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method], before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const replies = [];
    for (const [id, stepId] of [[recipes[other], steps[other]], [recipes[account], steps[other]], [recipes[account], "missing"]])
      replies.push(await handler(input(account, `/api/recipes/${id}/steps/${stepId}`, method, body, kind), { params: Promise.resolve({ id, stepId }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404, 404]);
    expect(await replies[0].json()).toEqual(await replies[2].clone().json()); expect(await replies[1].json()).toEqual(await replies[2].json());
    expect(snapshot()).toEqual(before); expect(effects.reads).not.toHaveBeenCalled(); expect(effects.engine).not.toHaveBeenCalled();
  }
});
it.each(["session", "token"])("lists only the %s owner's workflow definitions before decoding steps", async kind => {
  const { GET } = await import("@/app/api/recipes/route");
  for (const account of accounts) {
    const response = await GET(input(account, "/api/recipes", "GET", undefined, kind));
    expect(response.status).toBe(200); expect((await response.json()).recipes.map((r: { id: string }) => r.id)).toEqual([recipes[account]]);
  }
  db.prepare("UPDATE recipe_steps SET parameters = 'private invalid JSON' WHERE id = ?").run(steps.bob);
  expect((await GET(input("alice", "/api/recipes"))).status).toBe(200);
  expect(await (await GET(input("empty", "/api/recipes"))).json()).toEqual({ recipes: [] });
});
it("refuses hidden project references at creation and listing without partial writes", async () => {
  const { GET, POST } = await import("@/app/api/recipes/route"); const before = snapshot();
  for (const id of [projects.bob, "missing"]) {
    expect((await GET(input("alice", `/api/recipes?project=${id}`))).status).toBe(404);
    expect((await POST(input("alice", "/api/recipes", "POST", { name: "New", projectId: id }))).status).toBe(404);
    expect(snapshot()).toEqual(before);
  }
});
it("refuses hidden layer capture without adding or changing a workflow step", async () => {
  const { POST } = await import("@/app/api/recipes/[id]/steps/route");
  const { PATCH } = await import("@/app/api/recipes/[id]/steps/[stepId]/route"); const before = snapshot();
  const replies = [];
  for (const id of [layers.bob, "missing"]) {
    const body = { operation: "sql_step", fromLayerId: id, parameters: { name: "fresh" } };
    replies.push(await POST(input("alice", "/api/recipes/steps", "POST", body), { params: Promise.resolve({ id: recipes.alice }) }));
    replies.push(await PATCH(input("alice", "/api/recipes/steps", "PATCH", body), { params: Promise.resolve({ id: recipes.alice, stepId: steps.alice }) }));
  }
  expect(replies.map(r => r.status)).toEqual([404, 404, 404, 404]);
  expect(await replies[0].json()).toEqual(await replies[2].json()); expect(await replies[1].json()).toEqual(await replies[3].json());
  expect(snapshot()).toEqual(before); expect(effects.reads).not.toHaveBeenCalled();
});
function table(name: string): DataTable {
  return { id: `id-${name}`, name, file: `tables/${name}.parquet`, format: "csv", sourceFilename: null,
    geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1,
    source: "upload", sourceParams: null, importedAt: null, createdAt: "time" };
}
it("ignores another account's datasets and pending declarations when allocating output names", async () => {
  const { POST } = await import("@/app/api/recipes/[id]/steps/route");
  const { duplicateRecipe } = await import("@/lib/operations/recipe-duplicate");
  insertTable(testAccountScope(db, "bob"), table("private_input"), db);
  insertTable(testAccountScope(db, "bob"), table("roads_copy"), db);
  addStep(recipes.bob, { operation: "sql_step", parameters: { name: "roads_copy_2", sql: "SELECT 2" } }, db);
  const response = await POST(input("alice", "/api/recipes/steps", "POST", { operation: "sql_step", parameters: { sql: "SELECT 1", name: "private_input" } }), { params: Promise.resolve({ id: recipes.alice }) });
  expect(response.status).toBe(201);
  const copy = await duplicateRecipe(testAccountScope(db, "alice"), recipes.alice);
  expect(db.prepare("SELECT parameters FROM recipe_steps WHERE recipe_id = ? ORDER BY ordinal").all(copy.id)).toEqual([
    { parameters: JSON.stringify({ sql: "SELECT 'alice'", name: "roads_copy" }) },
    { parameters: JSON.stringify({ sql: "SELECT 1", name: "private_input_copy" }) },
  ]);
});
it("requires ownership at workflow services and rolls back mixed references", async () => {
  const owned = await import("@/lib/metadata/owned-recipes");
  const { captureLayerSource } = await import("@/lib/operations/recipe-api");
  const { readRecipe } = await import("@/lib/operations/recipe-view");
  const scope = testAccountScope(db, "alice"), before = snapshot();
  for (const id of [recipes.bob, "missing"]) {
    expect(() => owned.listSteps(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.addStep(scope, id, { operation: "sql_step", parameters: {} })).toThrow(expect.objectContaining({ status: 404 }));
    await expect(readRecipe(scope, id)).rejects.toMatchObject({ status: 404 });
  }
  for (const id of [steps.bob, "missing"]) {
    expect(() => owned.editStep(scope, id, {})).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.removeStep(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.reorderSteps(scope, recipes.alice, [steps.alice, id])).toThrow(expect.objectContaining({ status: 404 }));
  }
  for (const id of [projects.bob, "missing"]) expect(() => owned.fileRecipe(scope, recipes.alice, id)).toThrow(expect.objectContaining({ status: 404 }));
  for (const id of [layers.bob, "missing"]) {
    expect(() => captureLayerSource(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.addStep(scope, recipes.alice, { operation: "sql_step", parameters: {}, origin: { layerId: id } })).toThrow(expect.objectContaining({ status: 404 }));
  }
  for (const invalid of [undefined, null, { accountId: "alice" }]) {
    const missing = invalid as Parameters<typeof owned.listRecipes>[0];
    expect(() => owned.listRecipes(missing)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => owned.addStep(missing, recipes.alice, { operation: "sql_step", parameters: {} })).toThrow(expect.objectContaining({ status: 401 }));
  }
  expect(snapshot()).toEqual(before); expect(effects.reads).not.toHaveBeenCalled();
});
it.each(["add", "edit", "duplicate", "read"])("refuses a late workflow %s after account deactivation", async operation => {
  const scope = testAccountScope(db, "alice");
  const before = snapshot();
  effects.reads.mockImplementationOnce(async () => { db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); return []; });
  if (operation === "duplicate") {
    const { duplicateRecipe } = await import("@/lib/operations/recipe-duplicate");
    await expect(duplicateRecipe(scope, recipes.alice)).rejects.toMatchObject({ status: 401 });
  } else if (operation === "read") {
    const { readRecipe } = await import("@/lib/operations/recipe-view");
    await expect(readRecipe(scope, recipes.alice)).rejects.toMatchObject({ status: 401 });
  } else {
    const body = { operation: "sql_step", parameters: { sql: "SELECT 2", name: operation === "edit" ? "roads" : "fresh" } };
    const req = input("alice", "/api/recipes", operation === "edit" ? "PATCH" : "POST", body);
    const response = operation === "add" ? await (await import("@/app/api/recipes/[id]/steps/route")).POST(req, { params: Promise.resolve({ id: recipes.alice }) })
      : await (await import("@/app/api/recipes/[id]/steps/[stepId]/route")).PATCH(req, { params: Promise.resolve({ id: recipes.alice, stepId: steps.alice }) });
    expect(response.status).toBe(401);
  }
  expect(snapshot()).toEqual(before);
});
it("rechecks a captured layer before committing the new step", async () => {
  const before = snapshot();
  effects.reads.mockImplementationOnce(async () => { db.prepare("DELETE FROM layers WHERE id = ?").run(layers.alice); return []; });
  const { POST } = await import("@/app/api/recipes/[id]/steps/route");
  const response = await POST(input("alice", "/api/recipes", "POST", { operation: "sql_step", fromLayerId: layers.alice, parameters: { name: "fresh" } }), { params: Promise.resolve({ id: recipes.alice }) });
  expect(response.status).toBe(404); expect(snapshot()).toEqual(before);
});
it("duplicates captured SQL and historical origin after the source layer is deleted", async () => {
  const { captureLayerSource } = await import("@/lib/operations/recipe-api");
  const { duplicateRecipe } = await import("@/lib/operations/recipe-duplicate");
  const scope = testAccountScope(db, "alice"), captured = captureLayerSource(scope, layers.alice);
  db.prepare("UPDATE recipe_steps SET origin = ? WHERE id = ?").run(JSON.stringify(captured.origin), steps.alice);
  db.prepare("DELETE FROM layers WHERE id = ?").run(layers.alice);
  const copy = await duplicateRecipe(scope, recipes.alice);
  const row = db.prepare("SELECT origin, parameters FROM recipe_steps WHERE recipe_id = ?").get(copy.id) as { origin: string; parameters: string };
  expect(JSON.parse(row.origin)).toEqual(captured.origin);
  expect(JSON.parse(row.parameters)).toEqual({ sql: "SELECT 'alice'", name: "roads_copy" });
});
