import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createProject, fileMap, fileRecipe, fileTable } from "@/lib/metadata/projects";
import { createRecipe } from "@/lib/metadata/recipes";
import { insertTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

const filesProbe = vi.hoisted(() => ({ afterStat: null as ((file: unknown) => void) | null }));
vi.mock("node:fs/promises", async original => {
  const files = await original<typeof import("node:fs/promises")>();
  const stat = (async (...args: Parameters<typeof files.stat>) => {
    const result = await files.stat(...args); filesProbe.afterStat?.(args[0]); return result;
  }) as typeof files.stat;
  return { ...files, stat };
});
let db: Database;
let projects: Record<string, string>, maps: Record<string, string>, recipes: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  filesProbe.afterStat = null;
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  projects = {}; maps = {}; recipes = {};
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    projects[account] = createProject(scope, { name: `Private ${account}` }, db).id;
    maps[account] = createMap(scope, `Private ${account}`).id;
    recipes[account] = createRecipe(scope, `Private ${account}`, db).id;
    insertTable(scope, { id: account, name: `private_${account}`, file: `tables/${account}.parquet`, format: "csv", sourceFilename: null,
      geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1,
      source: "upload", sourceParams: null, importedAt: null, createdAt: "time" }, db);
    fileMap(maps[account], projects[account], db); fileRecipe(recipes[account], projects[account], db); fileTable(account, projects[account], db);
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Projects", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() { return ["projects", "maps", "recipes", "data_tables", "project_datasets"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()); }
const cases = [
  ["read", "GET", undefined, () => import("@/app/api/projects/[id]/route")],
  ["rename", "PATCH", { name: "Changed" }, () => import("@/app/api/projects/[id]/route")],
  ["delete", "DELETE", undefined, () => import("@/app/api/projects/[id]/route")],
  ["members", "GET", undefined, () => import("@/app/api/projects/[id]/members/route")],
  ["change members", "PATCH", {}, () => import("@/app/api/projects/[id]/members/route")],
  ["export", "POST", { maps: [], recipes: [], tables: [], file: "private" }, () => import("@/app/api/projects/[id]/export/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
it.each(cases)("refuses hidden project %s exactly like absence", async (_label, method, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method], before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const replies = [];
    for (const id of [projects[other], "missing"]) replies.push(await handler(input(account, `/api/projects/${id}`, method, body, kind), { params: Promise.resolve({ id }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json());
    expect(snapshot()).toEqual(before);
  }
});
it.each(["session", "token"])("lists only the %s owner's projects, counts and members", async kind => {
  const { GET } = await import("@/app/api/projects/route");
  const { GET: members } = await import("@/app/api/projects/[id]/members/route");
  for (const account of accounts) {
    const response = await GET(input(account, "/api/projects", "GET", undefined, kind));
    expect(response.status).toBe(200); const listed = await response.json();
    expect(listed).toEqual([expect.objectContaining({ id: projects[account], mapCount: 1, recipeCount: 1, tableCount: 1 })]);
    const content = await members(input(account, "/api/projects/members", "GET", undefined, kind), { params: Promise.resolve({ id: projects[account] }) });
    expect(content.status).toBe(200); const body = await content.json();
    expect(body.maps.map((m: { id: string }) => m.id)).toEqual([maps[account]]);
    expect(body.recipes.map((r: { id: string }) => r.id)).toEqual([recipes[account]]);
    expect(body.tables.map((t: { id: string }) => t.id)).toEqual([account]);
  }
  expect(await (await GET(input("empty", "/api/projects"))).json()).toEqual([]);
});
const fields = ["addMaps", "removeMaps", "addRecipes", "removeRecipes", "addTables", "removeTables"] as const;
function member(field: string, account: string) { return field.endsWith("Maps") ? maps[account] : field.endsWith("Recipes") ? recipes[account] : account; }
it.each(fields)("refuses mixed %s atomically through the membership API", async field => {
  const { PATCH } = await import("@/app/api/projects/[id]/members/route"); const before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const replies = [];
    for (const id of [member(field, other), "missing"]) replies.push(await PATCH(input(account, "/api/projects/members", "PATCH", { [field]: [member(field, account), id] }, kind), { params: Promise.resolve({ id: projects[account] }) }));
    expect(replies.map(r => r.status)).toEqual([404, 404]); expect(await replies[0].json()).toEqual(await replies[1].json());
    expect(snapshot()).toEqual(before);
  }
});
it.each(fields)("refuses mixed initial %s at the service boundary without creating a project", field => {
  const before = snapshot();
  for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const scope = testAccountScope(db, account);
    for (const id of [member(field, other), "missing"]) {
      expect(() => createProject(scope, { name: "Uncommitted", members: { [field]: [member(field, account), id] } }, db)).toThrow(expect.objectContaining({ status: 404 }));
      expect(snapshot()).toEqual(before);
    }
  }
});
it("deleting an owned project only unfiles its contents and preserves another filing", async () => {
  const { DELETE } = await import("@/app/api/projects/[id]/route");
  const extra = createProject(testAccountScope(db, "alice"), { name: "Second filing", members: { addTables: ["alice"] } }, db);
  const before = snapshot();
  const response = await DELETE(input("alice", "/api/projects", "DELETE"), { params: Promise.resolve({ id: projects.alice }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ contentsRemain: true });
  expect(db.prepare("SELECT id, owner_id FROM maps ORDER BY id").all()).toHaveLength(3);
  expect(db.prepare("SELECT project_id FROM maps WHERE id = ?").get(maps.alice)).toEqual({ project_id: null });
  expect(db.prepare("SELECT project_id FROM recipes WHERE id = ?").get(recipes.alice)).toEqual({ project_id: null });
  expect(db.prepare("SELECT project_id FROM project_datasets WHERE table_id = 'alice'").all()).toEqual([{ project_id: extra.id }]);
  expect(db.prepare("SELECT * FROM data_tables ORDER BY 1").all()).toEqual(before[3]);
  for (const account of ["bob", "admin"]) {
    expect(db.prepare("SELECT project_id FROM maps WHERE id = ?").get(maps[account])).toEqual({ project_id: projects[account] });
    expect(db.prepare("SELECT project_id FROM recipes WHERE id = ?").get(recipes[account])).toEqual({ project_id: projects[account] });
  }
});
it("checks service scopes and every member before touching names, notes or filing clocks", async () => {
  const owned = await import("@/lib/metadata/owned-projects");
  const scope = testAccountScope(db, "alice"), before = snapshot();
  for (const id of [projects.bob, "missing"]) {
    expect(() => owned.updateProject(scope, id, { name: "Changed", note: "Changed" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.deleteProject(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.projectMemberIds(scope, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.fileMap(scope, maps.alice, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.fileRecipe(scope, recipes.alice, id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => owned.fileTable(scope, "alice", id)).toThrow(expect.objectContaining({ status: 404 }));
  }
  expect(() => owned.changeMembers(scope, projects.alice, { removeMaps: [maps.alice], removeRecipes: [recipes.bob] })).toThrow(expect.objectContaining({ status: 404 }));
  for (const invalid of [undefined, null, { accountId: "alice" }]) {
    const missing = invalid as Parameters<typeof owned.listProjects>[0];
    expect(() => owned.listProjects(missing)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => owned.projectMemberCounts(missing)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => owned.changeMembers(missing, projects.alice, {})).toThrow(expect.objectContaining({ status: 401 }));
  }
  expect(snapshot()).toEqual(before);
});
it("refuses hidden export selections before staging an archive", async () => {
  const { assembleProjectExport } = await import("@/lib/export/project-export");
  const scope = testAccountScope(db, "alice");
  for (const kind of ["maps", "recipes", "tables"] as const) for (const id of [member(`add${kind[0].toUpperCase()}${kind.slice(1)}`, "bob"), "missing"]) {
    await expect(assembleProjectExport(scope, projects.alice, { maps: [], recipes: [], tables: [], file: "private", [kind]: [id] }))
      .rejects.toMatchObject({ status: 404, message: "The requested resource was not found." });
  }
});
it("discards a completed archive after owner deactivation and removes its staged file", async () => {
  const { assembleProjectExport } = await import("@/lib/export/project-export");
  const { stat: nativeStat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const scope = testAccountScope(db, "alice"); let archive = "";
  filesProbe.afterStat = file => {
    if (String(file).endsWith(".zip")) { archive = String(file); db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); }
  };
  await expect(assembleProjectExport(scope, projects.alice, { maps: [maps.alice], recipes: [], tables: [], file: "private" })).rejects.toMatchObject({ status: 401 });
  expect(archive).not.toBe(""); await expect(nativeStat(archive)).rejects.toMatchObject({ code: "ENOENT" });
});
it("filters counts and member identities by both owners before decoding content", async () => {
  const { projectMemberCounts, projectMemberIds } = await import("@/lib/metadata/owned-projects");
  const { projectMembers, projectsOverview } = await import("@/lib/project-service");
  db.prepare("UPDATE maps SET project_id = ?, publish_token = 'private-public-token' WHERE id = ?").run(projects.alice, maps.bob);
  db.prepare("UPDATE recipes SET project_id = ? WHERE id = ?").run(projects.alice, recipes.bob);
  db.prepare("INSERT INTO project_datasets (project_id, table_id, added_at) VALUES (?, 'bob', 'time')").run(projects.alice);
  // A dataset Alice does not reach is never decoded for her.
  insertTable(testAccountScope(db, "bob"), { id: "bob-private", name: "bob_private", file: "tables/bob-private.parquet", format: "csv", sourceFilename: null,
    geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1,
    source: "upload", sourceParams: null, importedAt: null, createdAt: "time" }, db);
  db.prepare("UPDATE data_tables SET source_params = 'private invalid JSON' WHERE id = 'bob-private'").run();
  const scope = testAccountScope(db, "alice");
  expect(projectMemberCounts(scope).get(projects.alice)).toEqual({ maps: 1, publishedMaps: 0, recipes: 1, tables: 1 });
  expect(projectMemberIds(scope, projects.alice)).toEqual({ maps: [maps.alice], recipes: [recipes.alice], tables: ["alice"] });
  expect((await projectsOverview(scope)).map(p => p.id)).toEqual([projects.alice]);
  const members = await projectMembers(scope, projects.alice);
  // A map filed in Alice's project is hers to reach as the project's owner,
  // whoever owns it; Bob, who does not reach her project, sees none of it.
  expect(new Set(members.maps.map(m => m.id))).toEqual(new Set([maps.alice, maps.bob]));
  await expect(projectMembers(testAccountScope(db, "bob"), projects.alice)).rejects.toMatchObject({ code: "not_found" });
  expect(members.recipes.map(r => r.id)).toEqual([recipes.alice]);
  // So is a dataset filed there, whoever owns it.
  expect(new Set(members.tables.map(t => t.id))).toEqual(new Set(["alice", "bob"]));
});
it("each account can create, rename, refile and dissolve its own project", async () => {
  const { POST } = await import("@/app/api/projects/route");
  const { PATCH, DELETE } = await import("@/app/api/projects/[id]/route");
  const { PATCH: members } = await import("@/app/api/projects/[id]/members/route");
  for (const account of accounts) {
    const body = { name: "Shared display name", ownerId: "bob", members: { addMaps: [maps[account]], addRecipes: [recipes[account]], addTables: [account] } };
    const response = await POST(input(account, "/api/projects", "POST", body));
    expect(response.status).toBe(201); const project = await response.json();
    expect(project).toMatchObject({ mapCount: 1, recipeCount: 1, tableCount: 1 });
    expect(db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(project.id)).toEqual({ owner_id: account });
    expect((await PATCH(input(account, "/api/projects", "PATCH", { name: "Renamed", note: "Personal" }), { params: Promise.resolve({ id: project.id }) })).status).toBe(200);
    const removed = await members(input(account, "/api/projects/members", "PATCH", { removeMaps: [maps[account]], removeRecipes: [recipes[account]], removeTables: [account] }), { params: Promise.resolve({ id: project.id }) });
    expect(removed.status).toBe(200); expect(await removed.json()).toEqual({ maps: [], recipes: [], tables: [] });
    expect((await DELETE(input(account, "/api/projects", "DELETE"), { params: Promise.resolve({ id: project.id }) })).status).toBe(200);
    expect(db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(account)).toEqual({ owner_id: account });
  }
});
