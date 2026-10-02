import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";

/**
 * Who reads a map, its layers, widgets, history and snapshot.
 *
 * Pat owns project P, where Ada and Edd are editors and Viv a viewer; Out, an
 * admin, owns project Q, where nobody else belongs; Zed belongs to nothing.
 * Ada owns map M filed in P (published), U unfiled, and Z filed in Q, a
 * project she cannot reach (as when she is removed from it); Pat owns PM,
 * filed in P. People rows are written
 * directly: no route adds them yet.
 *
 * A map is reached by its owner and by the owner and people of the project it
 * is filed in. Everyone who reaches it lists and reads it with its owner and
 * SQL home; nobody else sees anything, byte-equal to a map that never existed,
 * on session and token alike, and no read changes anything.
 */
const effects = vi.hoisted(() => ({
  thumbnail: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])),
  query: vi.fn(async () => { throw new Error("Unexpected query"); }),
}));
vi.mock("@/lib/map-thumbnails", async original => ({ ...await original<object>(), readThumbnail: effects.thumbnail,
  copyThumbnail: vi.fn(async () => {}) }));
vi.mock("@/lib/query/bounded", async original => ({ ...await original<object>(), boundedEvaluation: effects.query }));

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "edd", "viv", "out", "zed"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.prepare("UPDATE accounts SET name = 'Ada Lovelace' WHERE id = 'ada'").run();
  const style = JSON.stringify(defaultStyle(null));
  const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at(1)}', '${at(1)}', 'pat'),
      ('Q', 'Audit', '${at(1)}', '${at(1)}', 'out');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${at(1)}'), ('P', 'edd', 'editor', '${at(1)}'), ('P', 'viv', 'viewer', '${at(1)}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, publish_token, published_at)
      VALUES ('M', 'Shared map', '${at(1)}', '${at(1)}', 'ada', 'P', 'token-shared-map-000000', '${at(1)}'),
             ('U', 'Unfiled map', '${at(2)}', '${at(2)}', 'ada', NULL, NULL, NULL),
             ('PM', 'Pat map', '${at(3)}', '${at(3)}', 'pat', 'P', NULL, NULL),
             ('Z', 'Audited map', '${at(4)}', '${at(4)}', 'ada', 'Q', NULL, NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('L', 'M', 'Roads', 'SELECT 1 AS v', '${style}', 0, '${at(1)}', '${at(1)}'),
             ('UL', 'U', 'Roads', 'SELECT 1 AS v', '${style}', 0, '${at(2)}', '${at(2)}'),
             ('PL', 'PM', 'Parks', 'SELECT 1 AS v', '${style}', 0, '${at(3)}', '${at(3)}'),
             ('ZL', 'Z', 'Audit', 'SELECT 1 AS v', '${style}', 0, '${at(4)}', '${at(4)}');`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, method = "GET", body?: unknown, kind: "session" | "token" = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Reads", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const route = {
  maps: () => import("@/app/api/maps/route"),
  map: () => import("@/app/api/maps/[id]/route"),
  layers: () => import("@/app/api/maps/[id]/layers/route"),
  layer: () => import("@/app/api/layers/[id]/route"),
  history: () => import("@/app/api/maps/[id]/history/route"),
  undo: () => import("@/app/api/maps/[id]/undo/route"),
  publish: () => import("@/app/api/maps/[id]/publish/route"),
  thumbnail: () => import("@/app/api/maps/[id]/thumbnail/route"),
  duplicate: () => import("@/app/api/maps/[id]/duplicate/route"),
  sketches: () => import("@/app/api/maps/[id]/sketches/route"),
};
async function call(load: () => Promise<Record<string, unknown>>, method: string, request: Request, params: Record<string, string> = {}) {
  const handler = (await load())[method] as Handler;
  const response = await handler(request, { params: Promise.resolve(params) });
  const json = response.headers.get("content-type")?.includes("json");
  const text = json ? await response.text() : "";
  return { status: response.status, text, body: text ? JSON.parse(text) as unknown : null };
}
const list = async (account: string, query = "", kind: "session" | "token" = "session") =>
  call(route.maps, "GET", input(account, `/api/maps${query}`, "GET", undefined, kind));
const ids = (body: unknown) => (body as { id: string }[]).map(map => map.id);
function snapshot() {
  return ["maps", "layers", "map_history", "projects", "project_people", "data_tables"]
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const ADA = { name: "Ada Lovelace", sqlName: "ada" };

describe("listing maps over reach", () => {
  it("lists exactly the maps each account reaches, most recent first", async () => {
    expect(ids((await list("ada")).body)).toEqual(["Z", "PM", "U", "M"]);
    expect(ids((await list("pat")).body)).toEqual(["PM", "M"]);
    expect(ids((await list("edd")).body)).toEqual(["PM", "M"]);
    expect(ids((await list("viv")).body)).toEqual(["PM", "M"]);
    // An admin reaches what its own project holds, and nothing for being an admin.
    expect(ids((await list("out")).body)).toEqual(["Z"]);
    expect(ids((await list("zed")).body)).toEqual([]);
  });

  it("names every listed map's owner and SQL home, and its project where the caller reaches it or the map is the caller's own", async () => {
    const byId = (body: unknown) => new Map((body as { id: string }[]).map(map => [map.id, map as Record<string, unknown>]));
    const viv = byId((await list("viv")).body);
    expect(viv.get("M")).toMatchObject({ owner: ADA, home: "ada", projectId: "P", layerCount: 1 });
    expect(viv.get("PM")).toMatchObject({ owner: { name: "pat", sqlName: "pat" }, home: "pat", projectId: "P" });
    const ada = byId((await list("ada")).body);
    expect(ada.get("U")).toMatchObject({ owner: ADA, home: "ada", projectId: null });
    // Filed in a project Ada cannot reach: her own map still names it, by
    // identity, so she can take it out; the project stays absent to her.
    expect(ada.get("Z")).toMatchObject({ owner: ADA, projectId: "Q" });
    expect(byId((await list("out")).body).get("Z")).toMatchObject({ owner: ADA, home: "ada", projectId: "Q" });
    for (const map of [...viv.values(), ...ada.values()]) expect(JSON.stringify(map)).not.toContain("@example.test");
  });

  it("narrows to any reached project, keeps none as the caller's own maps filed nowhere, and refuses an unreached project as a missing one", async () => {
    expect(ids((await list("viv", "?project=P")).body)).toEqual(["PM", "M"]);
    expect(ids((await list("ada", "?project=P")).body)).toEqual(["PM", "M"]);
    expect(ids((await list("ada", "?project=none")).body)).toEqual(["U"]);
    expect(ids((await list("viv", "?project=none")).body)).toEqual([]);
    expect(ids((await list("out", "?project=Q")).body)).toEqual(["Z"]);
    for (const [account, project] of [["zed", "P"], ["ada", "Q"], ["out", "P"]]) {
      for (const kind of ["session", "token"] as const) {
        const hidden = await list(account, `?project=${project}`, kind);
        const missing = await list(account, "?project=never-existed", kind);
        expect(hidden.status, `${account} ${project} ${kind}`).toBe(404);
        expect(hidden.body).toEqual(missing.body);
      }
    }
  });
});

describe("a publication's token", () => {
  const TOKEN = "token-shared-map-000000";
  it("is read by the map's owner alone: everyone else who reaches the map reads that it is published, and since when", async () => {
    const owner = await call(route.map, "GET", input("ada", "/api/maps/M"), { id: "M" });
    expect(owner.body).toMatchObject({ publishToken: TOKEN, published: true });
    expect((await call(route.publish, "GET", input("ada", "/api/maps/M/publish"), { id: "M" })).body).toMatchObject({ token: TOKEN });
    expect((await list("ada")).text).toContain(TOKEN);
    for (const account of ["pat", "edd", "viv"]) {
      for (const kind of ["session", "token"] as const) {
        const read = await call(route.map, "GET", input(account, "/api/maps/M", "GET", undefined, kind), { id: "M" });
        expect(read.body, `${account} ${kind}`).toMatchObject({ publishToken: null, published: true, publishedAt: "2026-01-01T00:00:00.000Z" });
        for (const answer of [read, await list(account, "", kind),
          await call(route.publish, "GET", input(account, "/api/maps/M/publish", "GET", undefined, kind), { id: "M" })]) {
          expect(answer.text, `${account} ${kind}`).not.toContain(TOKEN);
        }
      }
      expect(((await list(account)).body as { id: string; published: boolean }[]).find(map => map.id === "M")).toMatchObject({ published: true, publishToken: null });
    }
    // An unpublished map reads unpublished to everyone.
    expect(((await list("viv")).body as { id: string; published: boolean }[]).find(map => map.id === "PM")).toMatchObject({ published: false, publishToken: null });
  });

  it("stays out of what an editor's own changes answer", async () => {
    const renamed = await call(route.map, "PATCH", input("edd", "/api/maps/M", "PATCH", { name: "Renamed" }), { id: "M" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", publishToken: null, published: true });
    const undone = await call(route.undo, "POST", input("edd", "/api/maps/M/undo", "POST"), { id: "M" });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ name: "Shared map", publishToken: null, published: true });
    for (const answer of [renamed, undone]) expect(answer.text).not.toContain(TOKEN);
  });
});

describe("reading a reached map", () => {
  it("serves the map with its layers, owner, SQL home and reached project to everyone who reaches it", async () => {
    for (const account of ["ada", "pat", "edd", "viv"]) {
      const read = await call(route.map, "GET", input(account, "/api/maps/M"), { id: "M" });
      expect(read.status, account).toBe(200);
      expect(read.body, account).toMatchObject({ id: "M", owner: ADA, home: "ada", projectId: "P", published: true, publishedAt: "2026-01-01T00:00:00.000Z" });
      expect((read.body as { layers: { id: string }[] }).layers.map(layer => layer.id)).toEqual(["L"]);
    }
    expect((await call(route.map, "GET", input("ada", "/api/maps/Z"), { id: "Z" })).body).toMatchObject({ projectId: "Q" });
    expect((await call(route.map, "GET", input("out", "/api/maps/Z"), { id: "Z" })).body).toMatchObject({ projectId: "Q", owner: ADA });
  });

  it("serves its layers, a layer, its history and its publication to everyone who reaches it", async () => {
    for (const account of ["pat", "edd", "viv"]) {
      expect((await call(route.layers, "GET", input(account, "/api/maps/M/layers"), { id: "M" })).body).toMatchObject([{ id: "L" }]);
      expect((await call(route.layer, "GET", input(account, "/api/layers/L"), { id: "L" })).body).toMatchObject({ id: "L", mapId: "M" });
      expect((await call(route.history, "GET", input(account, "/api/maps/M/history"), { id: "M" })).body).toEqual({ canUndo: false, canRedo: false });
      const state = (await call(route.publish, "GET", input(account, "/api/maps/M/publish"), { id: "M" })).body;
      expect(state, account).toMatchObject({ publishedAt: "2026-01-01T00:00:00.000Z", theme: "dark" });
      expect(state, account).not.toHaveProperty("token");
      expect((await call(route.sketches, "GET", input(account, "/api/maps/M/sketches"), { id: "M" })).body).toEqual([]);
    }
  });

  it("refuses everyone else exactly as a map, layer or project that never existed, on session and token, and no read changes anything", async () => {
    const before = snapshot();
    const reads: [() => Promise<Record<string, unknown>>, string, string, string][] = [
      [route.map, "/api/maps/{}", "M", "id"], [route.layers, "/api/maps/{}/layers", "M", "id"],
      [route.layer, "/api/layers/{}", "L", "id"], [route.history, "/api/maps/{}/history", "M", "id"],
      [route.publish, "/api/maps/{}/publish", "M", "id"], [route.thumbnail, "/api/maps/{}/thumbnail", "M", "id"],
      [route.sketches, "/api/maps/{}/sketches", "M", "id"],
    ];
    for (const [load, path, id] of reads) {
      for (const [account, hidden] of [["zed", id], ["out", id], ["viv", id === "L" ? "UL" : "U"], ["pat", id === "L" ? "ZL" : "Z"]]) {
        for (const kind of ["session", "token"] as const) {
          const refused = await call(load, "GET", input(account, path.replace("{}", hidden), "GET", undefined, kind), { id: hidden });
          const missing = await call(load, "GET", input(account, path.replace("{}", "never-existed"), "GET", undefined, kind), { id: "never-existed" });
          expect(refused.status, `${account} ${path} ${kind}`).toBe(404);
          expect(refused.body, `${account} ${path} ${kind}`).toEqual(missing.body);
        }
      }
    }
    expect(snapshot()).toEqual(before);
    expect(effects.thumbnail).not.toHaveBeenCalled();
    expect(effects.query).not.toHaveBeenCalled();
  });

  it("asks for the snapshot as each reader may be served it: the image's own record decides", async () => {
    for (const account of ["ada", "pat", "edd", "viv"]) {
      const read = await call(route.thumbnail, "GET", input(account, "/api/maps/M/thumbnail"), { id: "M" });
      expect(read.status, account).toBe(200);
      expect(effects.thumbnail).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: account }), "M", null);
    }
    expect(effects.thumbnail).toHaveBeenCalledTimes(4);
  });
});

describe("writes answer with the map as its writer sees it", () => {
  it("answers an editor's change and undo with the map's owner, SQL home and project", async () => {
    const renamed = await call(route.map, "PATCH", input("edd", "/api/maps/M", "PATCH", { name: "Edited" }), { id: "M" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: "M", name: "Edited", owner: ADA, home: "ada", projectId: "P" });
    const undone = await call(route.undo, "POST", input("edd", "/api/maps/M/undo", "POST"), { id: "M" });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ id: "M", name: "Shared map", owner: ADA, home: "ada", projectId: "P", history: { canRedo: true } });
  });

  it("answers a creation and the owner's duplicate with the caller as owner and home", async () => {
    const created = await call(route.maps, "POST", input("viv", "/api/maps", "POST", { name: "Mine" }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Mine", owner: { name: "viv", sqlName: "viv" }, home: "viv", projectId: null });
    const copy = await call(route.duplicate, "POST", input("ada", "/api/maps/U/duplicate", "POST"), { id: "U" });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: "Unfiled map copy", owner: ADA, home: "ada", projectId: null });
  });

  it("lets everyone who reaches a map duplicate it into their own space, and refuses everyone else as absent", async () => {
    for (const [account, projectId] of [["pat", "P"], ["edd", "P"], ["viv", null]] as const) {
      const copy = await call(route.duplicate, "POST", input(account, "/api/maps/M/duplicate", "POST"), { id: "M" });
      expect(copy.status, account).toBe(201);
      expect(copy.body, account).toMatchObject({ name: "Shared map copy", owner: { name: account, sqlName: account }, home: "ada", projectId });
    }
    // Ada reaches Z as its owner but cannot file into Q: her copy is unfiled.
    expect((await call(route.duplicate, "POST", input("ada", "/api/maps/Z/duplicate", "POST"), { id: "Z" })).body)
      .toMatchObject({ owner: ADA, home: "ada", projectId: null });
    const before = snapshot();
    const hidden = await call(route.duplicate, "POST", input("zed", "/api/maps/M/duplicate", "POST"), { id: "M" });
    const missing = await call(route.duplicate, "POST", input("zed", "/api/maps/never-existed/duplicate", "POST"), { id: "never-existed" });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(snapshot()).toEqual(before);
  });
});
