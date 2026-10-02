import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { PERMISSION_REFUSAL, requireFilingAddition, requireFilingRemoval, requirePermitted } from "./reach";

/**
 * Who may change a project.
 *
 * Pat owns projects P and Q; Ada and Ed are editors of P, Vi a viewer, Out an
 * admin who belongs to nothing. Ada files her map M, workflow W and dataset D
 * into P and keeps map U unfiled. People rows are written directly: no route
 * adds them yet, and every read is still the owner's alone.
 *
 * Rename, note and dissolution are the project owner's. Filing has its own
 * rules, named in the kernel before the filing routes take them: an owner
 * always withdraws their own resource, adding needs the destination's
 * permission and the resource must be one's own, the project's owner removes
 * anything, and a frozen project accepts nothing new. Membership and transfer
 * are the project owner's.
 */
const effects = vi.hoisted(() => ({ thumbnail: vi.fn(async () => {}), tiles: vi.fn(async () => {}) }));
vi.mock("@/lib/map-thumbnails", async original => ({ ...await original<object>(), prepareThumbnailRemoval: () => effects.thumbnail }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles }));

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "ed", "vi", "out"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  const style = JSON.stringify(defaultStyle(null));
  db.exec(`INSERT INTO projects (id, name, note, created_at, updated_at, owner_id) VALUES ('P', 'Survey', 'Keep this', '${now}', '${now}', 'pat'),
      ('Q', 'Other', NULL, '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('M', 'Filed map', '${now}', '${now}', 'ada', 'P'),
      ('U', 'Unfiled map', '${now}', '${now}', 'ada', NULL), ('E', 'Ed map', '${now}', '${now}', 'ed', NULL), ('V', 'Vi map', '${now}', '${now}', 'vi', NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES ('L', 'M', 'Roads', 'SELECT 1', '${style}', 0, '${now}', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES ('W', 'Filed workflow', 'workflow', '${now}', '${now}', 'ada', 'P');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('D', 'roads', 'geoparquet', 'tables/d.parquet', 1, '${now}', 'ada');
    INSERT INTO project_datasets VALUES ('P', 'D', '${now}');`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, method: string, body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Projects", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["projects", "project_people", "project_datasets", "maps", "layers", "recipes", "data_tables"]
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(load: () => Promise<Record<string, unknown>>, method: string, account: string, path: string, id: string, body?: unknown, kind = "session") {
  const handler = (await load())[method] as Handler;
  return handler(input(account, path, method, body, kind), { params: Promise.resolve({ id }) });
}
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };
const project = () => import("@/app/api/projects/[id]/route");
const writes = [
  { label: "rename the project", method: "PATCH", body: { name: "Renamed" }, effect: () => db.prepare("SELECT name FROM projects WHERE id = 'P'").get(), expected: { name: "Renamed" } },
  { label: "edit the project's note", method: "PATCH", body: { note: "Changed" }, effect: () => db.prepare("SELECT note FROM projects WHERE id = 'P'").get(), expected: { note: "Changed" } },
  { label: "dissolve the project", method: "DELETE", body: undefined,
    effect: () => [db.prepare("SELECT count(*) AS n FROM projects WHERE id = 'P'").get(), db.prepare("SELECT project_id FROM maps WHERE id = 'M'").get(),
      db.prepare("SELECT count(*) AS n FROM project_people").get()],
    expected: [{ n: 0 }, { project_id: null }, { n: 0 }] },
];

describe.each(writes)("$label", w => {
  for (const account of ["ada", "ed", "vi"]) {
    it(`refuses ${account} by the permission shape, alike across session and token, with nothing changed`, async () => {
      const before = snapshot();
      const session = await call(project, w.method, account, "/api/projects/P", "P", w.body);
      const token = await call(project, w.method, account, "/api/projects/P", "P", w.body, "token");
      expect({ status: session.status, body: await session.json() }).toEqual(forbidden);
      expect({ status: token.status, body: await token.json() }).toEqual(forbidden);
      expect(snapshot()).toEqual(before);
    });
  }
  it("refuses an outsider and an admin by the absent shape, alike across session and token, with nothing changed", async () => {
    const before = snapshot();
    const hidden = await call(project, w.method, "out", "/api/projects/P", "P", w.body);
    const token = await call(project, w.method, "out", "/api/projects/P", "P", w.body, "token");
    const missing = await call(project, w.method, "out", "/api/projects/missing", "missing", w.body);
    const parsed = { status: hidden.status, body: await hidden.json() };
    expect(parsed).toEqual({ status: missing.status, body: await missing.json() });
    expect(parsed.status).toBe(404);
    expect({ status: token.status, body: await token.json() }).toEqual(parsed);
    expect(snapshot()).toEqual(before);
  });
  it("lets the project's owner make it", async () => {
    const response = await call(project, w.method, "pat", "/api/projects/P", "P", w.body);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(w.effect()).toEqual(w.expected);
  });
});

describe("the project's owner and someone else's filed work", () => {
  it("cannot delete a filed map or workflow, which stays filed and whole", async () => {
    const before = snapshot();
    const map = await call(() => import("@/app/api/maps/[id]/route"), "DELETE", "pat", "/api/maps/M", "M");
    const workflow = await call(() => import("@/app/api/recipes/[id]/route"), "DELETE", "pat", "/api/recipes/W", "W");
    expect({ status: map.status, body: await map.json() }).toEqual(forbidden);
    expect({ status: workflow.status, body: await workflow.json() }).toEqual(forbidden);
    expect(snapshot()).toEqual(before);
    expect(effects.thumbnail).not.toHaveBeenCalled();
  });
});

describe("the filing rules", () => {
  const scope = (account: string) => testAccountScope(db, account);
  const outcome = (action: () => unknown) => { try { action(); return "allowed"; } catch (error) { return (error as { code: string }).code; } };
  const add = (account: string, kind: "map" | "workflow" | "dataset", id: string, projectId: string) =>
    outcome(() => requireFilingAddition(scope(account), kind, id, projectId, db));
  const remove = (account: string, kind: "map" | "workflow" | "dataset", id: string, projectId: string) =>
    outcome(() => requireFilingRemoval(scope(account), kind, id, projectId, db));

  it("adds only one's own resource, into a project one owns or edits", () => {
    expect(add("ada", "map", "U", "P")).toBe("allowed");
    expect(add("ed", "map", "E", "P")).toBe("allowed");
    expect(add("pat", "map", "U", "P")).toBe("not_found");
    expect(add("vi", "map", "V", "P")).toBe("forbidden");
    expect(add("ed", "map", "M", "P")).toBe("forbidden");
    expect(add("ed", "map", "U", "P")).toBe("not_found");
    expect(add("ada", "map", "U", "Q")).toBe("not_found");
    expect(add("out", "map", "U", "P")).toBe("not_found");
    expect(add("ada", "workflow", "W", "P")).toBe("allowed");
    expect(add("ed", "dataset", "D", "P")).toBe("forbidden");
  });

  it("lets an owner always withdraw their own resource and the project's owner remove anything", () => {
    for (const [kind, id] of [["map", "M"], ["workflow", "W"], ["dataset", "D"]] as const) {
      expect(remove("ada", kind, id, "P"), `${kind} owner`).toBe("allowed");
      expect(remove("pat", kind, id, "P"), `${kind} project owner`).toBe("allowed");
      expect(remove("ed", kind, id, "P"), `${kind} editor`).toBe("forbidden");
      expect(remove("vi", kind, id, "P"), `${kind} viewer`).toBe("forbidden");
      expect(remove("out", kind, id, "P"), `${kind} outsider`).toBe("not_found");
      expect(remove("pat", kind, id, "Q"), `${kind} not filed there`).toBe("not_found");
    }
    // Withdrawing one's own needs no standing in the project at all.
    db.prepare("DELETE FROM project_people WHERE account_id = 'ada'").run();
    expect(remove("ada", "map", "M", "P")).toBe("allowed");
  });

  it("keeps filing live under the freeze: withdrawal and removal go on, nothing new is filed", () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'pat'").run();
    expect(add("ada", "map", "U", "P")).toBe("forbidden");
    expect(remove("ada", "map", "M", "P")).toBe("allowed");
    db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'pat'").run();
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    expect(remove("pat", "map", "M", "P")).toBe("allowed");
  });

  it("names membership and transfer as the project owner's", () => {
    for (const action of ["membership", "transfer"] as const) {
      expect(outcome(() => requirePermitted(scope("pat"), "project", "P", action, db))).toBe("allowed");
      for (const account of ["ada", "ed", "vi"]) expect(outcome(() => requirePermitted(scope(account), "project", "P", action, db))).toBe("forbidden");
      expect(outcome(() => requirePermitted(scope("out"), "project", "P", action, db))).toBe("not_found");
    }
  });
});
