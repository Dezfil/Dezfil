import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";

/**
 * Projects over reach. Pat owns project P, where Ada is an editor and Viv a
 * viewer, and project Q, his alone; Ada owns project A, hers alone; Zed
 * belongs to nothing and Out is an admin. P holds Ada's published map M,
 * Pat's map PM, Ada's workflow W, Ada's dataset D and Pat's dataset D2, which
 * is also in Q. People rows are written directly: no route adds them yet.
 *
 * A project is listed and read by its owner and its people, each told the
 * project's owner and their role; its contents and counts cover everything
 * filed there, whoever owns it; a dataset names only the projects its reader
 * reaches; everyone else sees nothing, byte-equal to a project that never
 * existed.
 */
let db: Database;
const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "viv", "zed", "out"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at(1)}', '${at(1)}', 'pat'),
      ('Q', 'Audit', '${at(2)}', '${at(2)}', 'pat'), ('A', 'Ada alone', '${at(3)}', '${at(3)}', 'ada');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${at(1)}'), ('P', 'viv', 'viewer', '${at(1)}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, publish_token, published_at)
      VALUES ('M', 'Shared map', '${at(1)}', '${at(1)}', 'ada', 'P', 'token-shared-map-000000', '${at(1)}'),
             ('PM', 'Pat map', '${at(2)}', '${at(2)}', 'pat', 'P', NULL, NULL),
             ('AM', 'Ada map', '${at(3)}', '${at(3)}', 'ada', 'A', NULL, NULL);
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES ('W', 'Shared workflow', 'workflow', '${at(1)}', '${at(1)}', 'ada', 'P');
    INSERT INTO data_tables (owner_id, id, name, format, file, row_count, created_at, source)
      VALUES ('ada', 'D', 'roads', 'csv', 'tables/d.parquet', 1, '${at(1)}', 'upload'),
             ('pat', 'D2', 'parks', 'csv', 'tables/d2.parquet', 1, '${at(2)}', 'upload');
    INSERT INTO project_datasets VALUES ('P', 'D', '${at(1)}'), ('P', 'D2', '${at(1)}'), ('Q', 'D2', '${at(2)}');`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, kind: "session" | "token" = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Projects", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(load: () => Promise<Record<string, unknown>>, account: string, path: string, params: Record<string, string> = {}, kind: "session" | "token" = "session") {
  const response = await ((await load()).GET as Handler)(input(account, path, kind), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() as unknown };
}
const route = {
  projects: () => import("@/app/api/projects/route"),
  project: () => import("@/app/api/projects/[id]/route"),
  members: () => import("@/app/api/projects/[id]/members/route"),
  tables: () => import("@/app/api/tables/route"),
  recipes: () => import("@/app/api/recipes/route"),
};
type ProjectWire = { id: string; owner: { name: string; sqlName: string }; role: string; mapCount: number; publishedMapCount: number; recipeCount: number; tableCount: number };
const listed = async (account: string) => (await call(route.projects, account, "/api/projects")).body as ProjectWire[];
function snapshot() {
  return ["projects", "project_people", "project_datasets", "maps", "recipes", "data_tables"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}

describe("projects over reach", () => {
  it("lists the caller's own projects and the ones shared with them, with the owner and the caller's role", async () => {
    const shape = (rows: ProjectWire[]) => rows.map(p => [p.id, p.owner.sqlName, p.role]);
    expect(shape(await listed("pat"))).toEqual([["Q", "pat", "owner"], ["P", "pat", "owner"]]);
    expect(shape(await listed("ada"))).toEqual([["A", "ada", "owner"], ["P", "pat", "editor"]]);
    expect(shape(await listed("viv"))).toEqual([["P", "pat", "viewer"]]);
    expect(await listed("zed")).toEqual([]);
    expect(await listed("out")).toEqual([]);
  });

  it("counts everything filed in a reached project, whoever owns it, the same for every reader", async () => {
    for (const account of ["pat", "ada", "viv"]) {
      const project = (await listed(account)).find(p => p.id === "P")!;
      expect(project, account).toMatchObject({ mapCount: 2, publishedMapCount: 1, recipeCount: 1, tableCount: 2 });
    }
  });

  it("reads a shared project and lists its contents to its people", async () => {
    const read = await call(route.project, "viv", "/api/projects/P", { id: "P" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: "P", owner: { name: "pat", sqlName: "pat" }, role: "viewer", mapCount: 2 });
    for (const account of ["ada", "viv"]) {
      const contents = (await call(route.members, account, "/api/projects/P/members", { id: "P" })).body as
        { maps: { id: string }[]; recipes: { id: string }[]; tables: { id: string }[] };
      expect(contents.maps.map(m => m.id), account).toEqual(["PM", "M"]);
      expect(contents.recipes.map(r => r.id), account).toEqual(["W"]);
      expect(new Set(contents.tables.map(t => t.id)), account).toEqual(new Set(["D", "D2"]));
    }
  });

  it("names a dataset's memberships only in the projects its reader reaches", async () => {
    const parks = (account: string) => call(route.tables, account, "/api/tables").then(r => (r.body as { id: string; projectIds: string[] }[]).find(t => t.id === "D2")!);
    expect((await parks("viv")).projectIds).toEqual(["P"]);
    expect((await parks("pat")).projectIds).toEqual(["P", "Q"]);
    const recipes = (await call(route.recipes, "viv", "/api/recipes?project=P")).body as { recipes: { id: string; owner: { sqlName: string } }[] };
    expect(recipes.recipes).toMatchObject([{ id: "W", owner: { sqlName: "ada" } }]);
  });

  it("refuses everyone else exactly as a project that never existed, on session and token, without changing anything", async () => {
    const before = snapshot();
    for (const [account, project] of [["zed", "P"], ["out", "P"], ["viv", "Q"], ["viv", "A"], ["ada", "Q"]]) {
      for (const load of [route.project, route.members]) {
        for (const kind of ["session", "token"] as const) {
          const suffix = load === route.members ? "/members" : "";
          const hidden = await call(load, account, `/api/projects/${project}${suffix}`, { id: project }, kind);
          const missing = await call(load, account, `/api/projects/never-existed${suffix}`, { id: "never-existed" }, kind);
          expect(hidden.status, `${account} ${project}`).toBe(404);
          expect(hidden.body).toEqual(missing.body);
        }
      }
    }
    expect(snapshot()).toEqual(before);
  });
});
