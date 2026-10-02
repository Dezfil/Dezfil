import { readFilingRevisions } from "@/lib/test-support/edit-basis";
import { withFixtureRevision } from "@/lib/test-support/edit-basis";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { documentFacts } from "@/lib/metadata/document-facts";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { PERMISSION_REFUSAL } from "./reach";

/**
 * Filing and withdrawal through the routes, by the kernel's named rules.
 *
 * Pat owns project P; Ada and Ed are its editors and Vi its viewer; Out
 * belongs to nothing. Ada files her map M, workflow W and dataset D into P;
 * Vi filed her map VM there while she could. Ed owns map E, workflow EW and
 * dataset ED, unfiled, and map ER filed in his own project R. Vi owns map V.
 *
 * Adding needs the destination's permission: its owner, or an editor filing
 * their own resource. An owner always withdraws their own resource, member
 * or not; the project's owner removes anything, which never deletes or
 * reassigns it. A compound change that fails any part changes nothing.
 * Under the freeze a frozen project accepts nothing new while withdrawal and
 * removal go on, and contents others own keep their editing permissions.
 */
let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "ed", "vi", "out"]) testAccountScope(db, id);
  const style = JSON.stringify(defaultStyle(null));
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'pat'),
      ('R', 'Ed''s', '${now}', '${now}', 'ed');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('M', 'Ada map', '${now}', '${now}', 'ada', 'P'),
      ('VM', 'Vi filed map', '${now}', '${now}', 'vi', 'P'), ('E', 'Ed map', '${now}', '${now}', 'ed', NULL),
      ('ER', 'Ed other map', '${now}', '${now}', 'ed', 'R'), ('V', 'Vi map', '${now}', '${now}', 'vi', NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES ('L', 'M', 'Roads', 'SELECT 1', '${style}', 0, '${now}', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES ('W', 'Ada flow', 'workflow', '${now}', '${now}', 'ada', 'P'),
      ('EW', 'Ed flow', 'workflow', '${now}', '${now}', 'ed', NULL);
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('D', 'roads', 'geoparquet', 'tables/d.parquet', 1, '${now}', 'ada'),
      ('ED', 'stations', 'geoparquet', 'tables/ed.parquet', 1, '${now}', 'ed');
    INSERT INTO project_datasets VALUES ('P', 'D', '${now}');`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, method: string, body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Filing", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["projects", "project_people", "project_datasets", "maps", "layers", "recipes", "data_tables"]
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(load: () => Promise<Record<string, unknown>>, method: string, account: string, path: string, id: string, body?: unknown, kind = "session", basis?: string | null) {
  const response = await ((await load())[method] as Handler)(withFixtureRevision(input(account, path, method, body, kind), basis), { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
const route = {
  members: () => import("@/app/api/projects/[id]/members/route"),
  projects: () => import("@/app/api/projects/route"),
  maps: () => import("@/app/api/maps/route"),
  map: () => import("@/app/api/maps/[id]/route"),
  recipes: () => import("@/app/api/recipes/route"),
};
const file = (account: string, change: Record<string, string[]>, project = "P", kind = "session", expectedRevisions?: Record<string, string>) =>
  call(route.members, "PATCH", account, `/api/projects/${project}/members`, project, { ...change, expectedRevisions }, kind);
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };
const projectOf = (table: "maps" | "recipes", id: string) => (db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: string | null }).project_id;
const datasetProjects = (id: string) => (db.prepare("SELECT project_id FROM project_datasets WHERE table_id = ? ORDER BY 1").all(id) as { project_id: string }[]).map(r => r.project_id);
const ownerOf = (table: "maps" | "recipes" | "data_tables", id: string) => (db.prepare(`SELECT owner_id FROM ${table} WHERE id = ?`).get(id) as { owner_id: string }).owner_id;
async function refused(account: string, change: Record<string, string[]>, expected: "forbidden" | "absent", project = "P") {
  const before = snapshot();
  const session = await file(account, change, project, undefined, readFilingRevisions(change, db)), token = await file(account, change, project, "token", readFilingRevisions(change, db));
  expect(token).toEqual(session);
  if (expected === "forbidden") expect(session).toEqual(forbidden);
  else expect(session).toEqual(await file(account, change, "missing", undefined, readFilingRevisions(change, db)));
  expect(session.status).toBe(expected === "forbidden" ? 403 : 404);
  expect(snapshot()).toEqual(before);
}

describe("adding to a project", () => {
  it("lets an editor file their own map, workflow and dataset, answered with the project as they read it", async () => {
    const answer = await file("ed", { addMaps: ["E"], addRecipes: ["EW"], addTables: ["ED"] }, undefined, undefined, readFilingRevisions({ addMaps: ["E"], addRecipes: ["EW"], addTables: ["ED"] }, db));
    expect(answer.status).toBe(200);
    expect([projectOf("maps", "E"), projectOf("recipes", "EW"), datasetProjects("ED")]).toEqual(["P", "P", ["P"]]);
    expect((answer.body!.maps as { id: string }[]).map(m => m.id).sort()).toEqual(["E", "M", "VM"]);
  });

  it("moves an editor's own map out of the project it was in", async () => {
    expect((await file("ed", { addMaps: ["ER"] }, undefined, undefined, readFilingRevisions({ addMaps: ["ER"] }, db))).status).toBe(200);
    expect(projectOf("maps", "ER")).toBe("P");
  });

  it("refuses a viewer's own resource by the permission shape, and an outsider as absent", async () => {
    await refused("vi", { addMaps: ["V"] }, "forbidden");
    await refused("out", { addMaps: ["V"] }, "absent");
  });

  it("refuses filing someone else's resource: by the permission shape when reached, as absent when not", async () => {
    await refused("ed", { addMaps: ["M"] }, "forbidden");
    await refused("ed", { addTables: ["D"] }, "forbidden");
    await refused("ed", { addMaps: ["V"] }, "absent");
    await refused("pat", { addMaps: ["E"] }, "absent");
  });

  it("files at creation into a project the creator owns or edits, and refuses anyone else before creating anything", async () => {
    const created = await call(route.maps, "POST", "ed", "/api/maps", "", { name: "Fresh", projectId: "P" });
    expect(created.status).toBe(201);
    expect(projectOf("maps", created.body!.id as string)).toBe("P");
    const workflow = await call(route.recipes, "POST", "ed", "/api/recipes", "", { name: "Fresh flow", projectId: "P" });
    expect(workflow.status).toBe(201);
    expect(projectOf("recipes", (workflow.body!.recipe as { id: string }).id)).toBe("P");
    const before = snapshot();
    expect(await call(route.maps, "POST", "vi", "/api/maps", "", { name: "Nope", projectId: "P" })).toEqual(forbidden);
    expect(await call(route.recipes, "POST", "vi", "/api/recipes", "", { name: "Nope", projectId: "P" })).toEqual(forbidden);
    expect((await call(route.maps, "POST", "out", "/api/maps", "", { name: "Nope", projectId: "P" })).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
});

describe("removing from a project", () => {
  it("lets an owner withdraw their own resource, a viewer included", async () => {
    expect((await file("ada", { removeMaps: ["M"], removeRecipes: ["W"], removeTables: ["D"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["M"], removeRecipes: ["W"], removeTables: ["D"] }, db))).status).toBe(200);
    expect([projectOf("maps", "M"), projectOf("recipes", "W"), datasetProjects("D")]).toEqual([null, null, []]);
    expect((await file("vi", { removeMaps: ["VM"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["VM"] }, db))).status).toBe(200);
    expect(projectOf("maps", "VM")).toBeNull();
  });

  it("lets an owner withdraw their own resource from a project they no longer belong to", async () => {
    db.prepare("DELETE FROM project_people WHERE account_id = 'ada'").run();
    expect(await file("ada", { removeMaps: ["M"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["M"] }, db))).toEqual({ status: 200, body: { maps: [], recipes: [], tables: [], revisions: [{ kind: "map" as const, id: "M" }].map(doc => ({ ...doc, editRevision: documentFacts(doc, db).editRevision })) } });
    expect(projectOf("maps", "M")).toBeNull();
    // Anything else from outside the project is as if the project did not exist.
    await refused("ada", { removeRecipes: ["W"], addMaps: ["M"] }, "absent");
  });

  it("lets the project's owner remove anything, which never deletes or reassigns it", async () => {
    expect((await file("pat", { removeMaps: ["M", "VM"], removeRecipes: ["W"], removeTables: ["D"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["M", "VM"], removeRecipes: ["W"], removeTables: ["D"] }, db))).status).toBe(200);
    expect([projectOf("maps", "M"), projectOf("maps", "VM"), projectOf("recipes", "W"), datasetProjects("D")]).toEqual([null, null, null, []]);
    expect([ownerOf("maps", "M"), ownerOf("maps", "VM"), ownerOf("recipes", "W"), ownerOf("data_tables", "D")]).toEqual(["ada", "vi", "ada", "ada"]);
  });

  it("refuses an editor or a viewer removing someone else's resource by the permission shape", async () => {
    await refused("ed", { removeMaps: ["M"] }, "forbidden");
    await refused("vi", { removeTables: ["D"] }, "forbidden");
    await refused("out", { removeMaps: ["M"] }, "absent");
  });

  it("changes nothing for a removal of what is not filed there", async () => {
    const before = snapshot();
    expect((await file("ed", { removeMaps: ["E"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["E"] }, db))).status).toBe(200);
    expect(snapshot()).toEqual(before);
  });
});

describe("a compound change", () => {
  it("that fails any part changes nothing", async () => {
    await refused("ed", { addMaps: ["E"], removeMaps: ["M"] }, "forbidden");
    await refused("ed", { addMaps: ["E"], addRecipes: ["EW"], addTables: ["D"] }, "forbidden");
    await refused("ed", { addTables: ["ED"], addMaps: ["V"] }, "absent");
    const before = snapshot();
    const created = await call(route.projects, "POST", "ada", "/api/projects", "", { name: "New", members: { addMaps: ["M"], addTables: ["ED"] } });
    expect(created.status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
});

describe("the freeze", () => {
  it("leaves filing live: a frozen project accepts nothing new while its people withdraw their own", async () => {
    db.prepare("INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('EP', 'Ed filed', ?, ?, 'ed', 'P')").run(now, now);
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'pat'").run();
    await refused("ed", { addMaps: ["E"] }, "forbidden");
    expect((await call(route.maps, "POST", "ed", "/api/maps", "", { name: "Nope", projectId: "P" })).status).toBe(403);
    expect((await file("ed", { removeMaps: ["EP"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["EP"] }, db))).status).toBe(200);
    expect((await file("vi", { removeMaps: ["VM"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["VM"] }, db))).status).toBe(200);
    // Contents others own inside the frozen project keep their editing permissions.
    expect((await call(route.map, "PATCH", "ed", "/api/maps/M", "M", { name: "Edited" }, "session", readEditRevision({ kind: "map", id: "M" })!.editRevision)).status).toBe(200);
  });

  it("lets the active project owner remove a frozen resource, which stays read-only for everyone", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    expect(await call(route.map, "PATCH", "pat", "/api/maps/M", "M", { name: "Edited" }, "session", readEditRevision({ kind: "map", id: "M" })!.editRevision)).toEqual(forbidden);
    expect(await call(route.map, "PATCH", "ed", "/api/maps/M", "M", { name: "Edited" }, "session", readEditRevision({ kind: "map", id: "M" })!.editRevision)).toEqual(forbidden);
    expect((await file("pat", { removeMaps: ["M"], removeTables: ["D"] }, undefined, undefined, readFilingRevisions({ removeMaps: ["M"], removeTables: ["D"] }, db))).status).toBe(200);
    expect([projectOf("maps", "M"), datasetProjects("D"), ownerOf("maps", "M")]).toEqual([null, [], "ada"]);
  });
});
