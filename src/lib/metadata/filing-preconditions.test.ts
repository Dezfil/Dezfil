import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "./db";
import { createMap } from "@/lib/map-service";
import { createRecipe } from "./recipes";
import * as raw from "./projects";
import { createProject, changeMembers, fileMap, fileRecipe, deleteProject } from "./owned-projects";
import { transferMap, transferWorkflow } from "./transfers";
import { readDocumentRevision, recordDocumentChanges } from "./revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { POST as create } from "@/app/api/projects/route";
import { PATCH as members } from "@/app/api/projects/[id]/members/route";
import { POST as transferM } from "@/app/api/maps/[id]/transfer/route";
import { POST as transferW } from "@/app/api/recipes/[id]/transfer/route";
import { buildTools } from "@/lib/tools/tools";

let db: Database, map: string, workflow: string, project: string;
const scope = (id = "ada") => testAccountScope(db, id);
const revision = (kind: "map" | "workflow", id: string) => readDocumentRevision({ kind, id }, db)!.editRevision!;
const bases = () => ({ [`map:${map}`]: revision("map", map), [`workflow:${workflow}`]: revision("workflow", workflow) });
const snapshot = () => ["projects", "project_people", "maps", "recipes", "project_datasets", "map_history", "ownership_transfer_gate"].filter(t => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t)).map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
const request = (path: string, method: string, body: unknown, token?: string, actor = "ada") => testAccountRequest(new Request(`http://instance.test${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { "X-Edit-Revision": token } : {}) }, body: JSON.stringify(body) }), db, actor);
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "eli", "viewer"]) scope(id);
  map = createMap(scope(), "Map").id; workflow = createRecipe(scope(), "Workflow", db).id;
  project = createProject(scope(), { name: "Project" }, db).id;
  db.prepare("INSERT INTO project_people (project_id, account_id, role, added_at) VALUES (?, 'eli', 'editor', 'time'), (?, 'viewer', 'viewer', 'time')").run(project, project);
  raw.fileMap(map, project, db); raw.fileRecipe(workflow, project, db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it.each([undefined, "bad", "0".repeat(32)])("refuses every filing and transfer with basis %s without any partial write", async token => {
  const before = snapshot(), expected = token === "0".repeat(32) ? 409 : 400;
  for (const [kind, id, service, route] of [["map", map, transferMap, transferM], ["workflow", workflow, transferWorkflow, transferW]] as const) {
    expect.soft(() => service(scope(), id, "eli", db, { expectedRevision: token })).toThrow(expect.objectContaining({ status: expected }));
    const response = await route(request(`/api/${kind === "map" ? "maps" : "recipes"}/${id}/transfer`, "POST", { to: "eli" }, token), { params: Promise.resolve({ id }) });
    expect.soft(response.status).toBe(expected); expect.soft(snapshot()).toEqual(before);
  }
  expect.soft(() => fileMap(scope(), map, null, db, { expectedRevision: token })).toThrow(expect.objectContaining({ status: expected }));
  expect.soft(() => fileRecipe(scope(), workflow, null, db, { expectedRevision: token })).toThrow(expect.objectContaining({ status: expected }));
  const change = { removeMaps: [map], removeRecipes: [workflow], expectedRevisions: { ...bases(), [`workflow:${workflow}`]: token } };
  const response = await members(request(`/api/projects/${project}/members`, "PATCH", change), { params: Promise.resolve({ id: project }) });
  expect.soft(response.status).toBe(expected); expect.soft(snapshot()).toEqual(before);
  const created = await create(request("/api/projects", "POST", { name: "Must roll back", members: { addMaps: [map], addRecipes: [workflow], expectedRevisions: change.expectedRevisions } }));
  expect.soft(created.status).toBe(expected); expect.soft(snapshot()).toEqual(before);
});

it("chains compound results, checks no-ops and rolls back dataset membership with a stale document", async () => {
  db.prepare("INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('d', 'roads', 'geoparquet', 'tables/d.parquet', 1, 'time', 'ada')").run();
  const seen = bases();
  const results = changeMembers(scope(), project, { removeMaps: [map], removeRecipes: [workflow], expectedRevisions: seen }, db);
  expect(results).toHaveLength(2);
  for (const row of results) expect(row.editRevision).not.toBe(seen[`${row.kind}:${row.id}`]);
  const accepted = bases(), before = snapshot();
  changeMembers(scope(), project, { removeMaps: [map], removeRecipes: [workflow], expectedRevisions: accepted }, db);
  expect(snapshot()).toEqual(before);
  expect(() => changeMembers(scope(), project, { addMaps: [map], addRecipes: [workflow], addTables: ["d"], expectedRevisions: seen }, db)).toThrow(expect.objectContaining({ code: "stale_revision" }));
  expect(snapshot()).toEqual(before);
  const added = await create(request("/api/projects", "POST", { name: "Accepted", members: { addMaps: [map], addRecipes: [workflow], expectedRevisions: accepted } }));
  expect(added.status).toBe(201); expect((await added.json()).revisions).toHaveLength(2);
});

it("dissolves without member bases and advances every affected revision", () => {
  const seen = bases();
  db.transaction(() => recordDocumentChanges(scope(), [{ kind: "map", id: map }], db))();
  expect(() => fileMap(scope(), map, null, db, { expectedRevision: seen[`map:${map}`] })).toThrow(expect.objectContaining({ code: "stale_revision" }));
  const fresh = bases(); deleteProject(scope(), project, db);
  expect(revision("map", map)).not.toBe(fresh[`map:${map}`]);
  expect(revision("workflow", workflow)).not.toBe(fresh[`workflow:${workflow}`]);
});

it("keeps authorization before revisions and publishes the generated contracts", () => {
  const before = snapshot();
  expect(() => changeMembers(scope("viewer"), project, { removeMaps: [map] }, db)).toThrow(expect.objectContaining({ status: 403 }));
  expect(() => transferMap(scope("eli"), map, "viewer", db)).toThrow(expect.objectContaining({ status: 403 }));
  expect(snapshot()).toEqual(before);
  for (const name of ["transfer_map", "transfer_workflow"]) expect(buildTools().find(t => t.name === name)!.inputSchema.required).toContain("expected_revision");
  expect(buildTools().find(t => t.name === "update_project_members")!.inputSchema.properties).toHaveProperty("expectedRevisions");
});

it.each(["ada", "eli"])("allows withdrawal by a removed owner and by a project owner across freezing, owner %s", owner => {
  const other = owner === "ada" ? "eli" : "ada";
  const destination = createProject(scope(other), { name: "Other" }, db).id;
  db.prepare("INSERT INTO project_people VALUES (?, ?, 'editor', 'time')").run(destination, owner);
  const own = createMap(scope(owner), "Owned", destination);
  const seen = revision("map", own.id);
  db.prepare("DELETE FROM project_people WHERE project_id = ?").run(destination);
  changeMembers(scope(owner), destination, { removeMaps: [own.id], expectedRevisions: { [`map:${own.id}`]: seen } }, db);
  expect(revision("map", own.id)).not.toBe(seen);
  raw.fileMap(own.id, destination, db);
  const frozen = revision("map", own.id);
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(owner);
  const results = changeMembers(scope(other), destination, { removeMaps: [own.id], expectedRevisions: { [`map:${own.id}`]: frozen } }, db);
  expect(results).toEqual([]); // Its project membership was the acting owner's only reach.
  expect(revision("map", own.id)).not.toBe(frozen);
});

it("rolls back every membership, clock and revision after a late write failure", () => {
  db.exec("CREATE TEMP TRIGGER refuse_recipe_filing BEFORE UPDATE OF project_id ON recipes BEGIN SELECT RAISE(ABORT, 'injected filing failure'); END;");
  const before = snapshot();
  expect(() => changeMembers(scope(), project, { removeMaps: [map], removeRecipes: [workflow], expectedRevisions: bases() }, db)).toThrow("injected filing failure");
  expect(snapshot()).toEqual(before);
});
