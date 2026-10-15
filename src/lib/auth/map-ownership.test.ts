import { withFixtureRevision } from "@/lib/test-support/edit-basis";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createMap } from "@/lib/map-service";
import { createProject } from "@/lib/metadata/projects";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";

const effects = vi.hoisted(() => ({ inspect: vi.fn(async () => ({ url: "https://styles.example.test/style.json", name: null, attribution: [] })),
  thumbnail: vi.fn(async () => {}), tiles: vi.fn(async () => {}),
  served: vi.fn<(scope: unknown, mapIds: readonly string[]) => Promise<Map<string, null>>>(async () => new Map<string, null>()) }));
vi.mock("@/lib/basemap-custom", () => ({ resolveCustomBasemapWrite: effects.inspect }));
vi.mock("@/lib/map-thumbnails", () => ({ prepareThumbnailRemoval: () => effects.thumbnail, removeThumbnail: effects.thumbnail, copyThumbnail: effects.thumbnail, servedThumbnails: effects.served }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles }));

let db: Database;
let ids: Record<string, string>;
let projects: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  ids = {}; projects = {};
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    ids[account] = createMap(scope, `Private ${account}`).id;
    projects[account] = createProject(scope, { name: `Project ${account}` }, db).id;
    db.prepare("UPDATE maps SET publish_token = ?, published_at = 'time' WHERE id = ?").run(`token-${account}`, ids[account]);
    db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, ?, 'SELECT 1 AS secret', ?, 0, 'time', 'time')`).run(`layer-${account}`, ids[account], `Secret ${account}`, JSON.stringify(defaultStyle(null)));
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Maps", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["maps", "layers", "map_history", "projects", "map_thumbnails", "layer_tiles"]
    .filter(name => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const cases = [
  ["read", "GET", "", undefined, () => import("@/app/api/maps/[id]/route")],
  ["edit", "PATCH", "", { name: "Stolen", customBasemap: { url: "https://styles.example.test/style.json" } }, () => import("@/app/api/maps/[id]/route")],
  ["delete", "DELETE", "", undefined, () => import("@/app/api/maps/[id]/route")],
  ["duplicate", "POST", "/duplicate", {}, () => import("@/app/api/maps/[id]/duplicate/route")],
  ["publication read", "GET", "/publish", undefined, () => import("@/app/api/maps/[id]/publish/route")],
  ["publish", "POST", "/publish", { theme: "light" }, () => import("@/app/api/maps/[id]/publish/route")],
  ["unpublish", "DELETE", "/publish", undefined, () => import("@/app/api/maps/[id]/publish/route")],
] as const;

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
it.each(cases)("refuses another owner's map %s like a missing map, without protected effects", async (_label, method, suffix, body, load) => {
  const route = await load();
  const handler = (route as unknown as Record<string, Handler>)[method];
  const before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(id => id !== account)) {
    const hidden = await handler(input(account, `/api/maps/${ids[other]}${suffix}`, method, body, kind), { params: Promise.resolve({ id: ids[other] }) });
    const absent = await handler(input(account, `/api/maps/missing${suffix}`, method, body, kind), { params: Promise.resolve({ id: "missing" }) });
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    const payload = await hidden.json();
    expect(payload).toEqual(await absent.json());
    expect(JSON.stringify(payload)).not.toMatch(/Private|Secret|alice|bob|admin|SELECT|token-/);
    expect(snapshot()).toEqual(before);
    expect(effects.inspect).not.toHaveBeenCalled();
    expect(effects.thumbnail).not.toHaveBeenCalled();
    expect(effects.tiles).not.toHaveBeenCalled();
  }
});

it.each(["session", "token"])("lists only the authenticated %s owner's maps and layer counts", async kind => {
  const { GET } = await import("@/app/api/maps/route");
  for (const account of accounts) {
    const response = await GET(input(account, "/api/maps", "GET", undefined, kind));
    expect(response.status).toBe(200);
    const maps = await response.json();
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ id: ids[account], name: `Private ${account}`, layerCount: 1 });
  }
  testAccountScope(db, "empty");
  expect(await (await GET(input("empty", "/api/maps", "GET", undefined, kind))).json()).toEqual([]);
});

it.each(["GET", "POST"])("refuses a hidden project on map collection %s before creating or listing maps", async method => {
  const route = await import("@/app/api/maps/route");
  const handler = method === "GET" ? route.GET : route.POST;
  const before = snapshot();
  const responses = [];
  for (const projectId of [projects.bob, "missing"]) {
    responses.push(await handler(input("alice", `/api/maps?project=${projectId}`, method,
      method === "POST" ? { name: "Mixed", projectId } : undefined)));
  }
  expect(responses.map(response => response.status)).toEqual([404, 404]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect(snapshot()).toEqual(before);
});

it("requires authentication at the collection and resource adapters", async () => {
  const collection = await import("@/app/api/maps/route");
  const resource = await import("@/app/api/maps/[id]/route");
  const before = snapshot();
  const request = socketRequest(new Request("http://instance.test/api/maps"));
  expect((await collection.GET(request)).status).toBe(401);
  expect((await resource.GET(request, { params: Promise.resolve({ id: ids.alice }) })).status).toBe(401);
  expect(snapshot()).toEqual(before);
});

it.each(["session", "token"])("preserves each %s owner's read, edit, duplicate, publish and delete loop", async kind => {
  const { GET, PATCH, DELETE } = await import("@/app/api/maps/[id]/route");
  const { POST: duplicate } = await import("@/app/api/maps/[id]/duplicate/route");
  const publication = await import("@/app/api/maps/[id]/publish/route");
  for (const account of accounts) {
    const id = ids[account], context = { params: Promise.resolve({ id }) };
    expect((await GET(input(account, `/api/maps/${id}`, "GET", undefined, kind), context)).status).toBe(200);
    const edited = await PATCH(withFixtureRevision(input(account, `/api/maps/${id}`, "PATCH", { name: `Edited ${account}`, ownerId: "someone-else" }, kind), readEditRevision({ kind: "map", id: id })?.editRevision), context);
    expect(edited.status).toBe(200);
    const copy = await duplicate(input(account, `/api/maps/${id}/duplicate`, "POST", {}, kind), context);
    expect(copy.status).toBe(201);
    const copied = await copy.json();
    expect(copied.layers).toHaveLength(1);
    expect(copied.layers[0].id).not.toBe(`layer-${account}`);
    expect(db.prepare("SELECT owner_id FROM maps WHERE id = ?").get(copied.id)).toEqual({ owner_id: account });
    expect((await publication.DELETE(withFixtureRevision(input(account, `/api/maps/${id}/publish`, "DELETE", undefined, kind), readEditRevision({ kind: "map", id })?.editRevision), context)).status).toBe(200);
    const published = await publication.POST(withFixtureRevision(input(account, `/api/maps/${id}/publish`, "POST", { theme: "light" }, kind), readEditRevision({ kind: "map", id })?.editRevision), context);
    expect(published.status).toBe(201);
    expect((await published.json()).token).not.toBe(`token-${account}`);
    expect((await publication.GET(input(account, `/api/maps/${id}/publish`, "GET", undefined, kind), context)).status).toBe(200);
    expect((await DELETE(withFixtureRevision(input(account, `/api/maps/${id}`, "DELETE", undefined, kind), readEditRevision({ kind: "map", id: id })?.editRevision), context)).status).toBe(204);
    expect(db.prepare("SELECT id FROM maps WHERE id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT owner_id FROM maps WHERE id = ?").get(copied.id)).toEqual({ owner_id: account });
  }
});

it("rechecks deactivation after an asynchronous basemap inspection and preserves the map for reactivation", async () => {
  const { PATCH, GET } = await import("@/app/api/maps/[id]/route");
  const id = ids.alice, context = { params: Promise.resolve({ id }) };
  const before = snapshot();
  effects.inspect.mockImplementationOnce(async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    return { url: "https://styles.example.test/style.json", name: null, attribution: [] };
  });
  const response = await PATCH(withFixtureRevision(input("alice", `/api/maps/${id}`, "PATCH", { name: "Late", customBasemap: {} }), readEditRevision({ kind: "map", id: id })?.editRevision), context);
  expect(response.status).toBe(401);
  expect(snapshot()).toEqual(before);
  expect((await GET(input("admin", `/api/maps/${id}`), context)).status).toBe(404);
  db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(await (await GET(input("alice", `/api/maps/${id}`), context)).json()).toMatchObject({ id, name: "Private alice" });
});

it("requires explicit service scopes and refuses hidden map identities before any service work", async () => {
  const service = await import("@/lib/map-service");
  const publication = await import("@/lib/publish/publish-service");
  const { mapDependencies } = await import("@/lib/map-dependencies");
  const { getOwnedMap, listOwnedMaps } = await import("@/lib/metadata/map-queries");
  type Scope = Parameters<typeof service.requireMap>[0];
  const actions = (scope: Scope, id: string) => [
    () => service.requireMap(scope, id), () => service.mapWithLayers(scope, id),
    () => service.updateMap(scope, id, { name: "Changed" }), () => service.removeMap(scope, id),
    () => service.duplicateMap(scope, id), () => service.validateMapWriteRefs(scope, id, {}),
    () => publication.getPublicationState(scope, id), () => publication.publishMap(scope, id),
    () => publication.unpublishMap(scope, id), () => mapDependencies(scope, id), () => getOwnedMap(scope, id, db),
  ];
  const before = snapshot();
  for (const scope of [undefined, null, { accountId: "alice" }]) {
    const invalid = scope as Scope;
    for (const action of [...actions(invalid, ids.alice), () => service.allMaps(invalid),
      () => service.mapsOverview(invalid), () => listOwnedMaps(invalid, db)]) {
      await expect(Promise.resolve().then<unknown>(action)).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    }
  }
  for (const account of accounts) {
    const scope = testAccountScope(db, account);
    for (const other of accounts.filter(id => id !== account)) {
      for (const action of actions(scope, ids[other])) {
        await expect(Promise.resolve().then<unknown>(action)).rejects.toMatchObject({ code: "not_found", status: 404 });
      }
    }
  }
  expect(snapshot()).toEqual(before);
  expect(effects.inspect).not.toHaveBeenCalled();
  expect(effects.thumbnail).not.toHaveBeenCalled();
  expect(effects.tiles).not.toHaveBeenCalled();
});

describe("the listing rechecks access after its picture reads", () => {
  let shared: string;
  const removeBob = () => { db.prepare("DELETE FROM project_people WHERE project_id = ? AND account_id = 'bob'").run(projects.alice); };
  beforeEach(() => {
    shared = createMap(testAccountScope(db, "alice"), "Shared alice", projects.alice).id;
    db.prepare("INSERT INTO project_people VALUES (?, ?, ?, 'time')").run(projects.alice, "bob", "viewer");
  });
  /** Lists while the picture reads are held open, runs `meanwhile`, then lets them answer every map pictured. */
  async function heldListing(account: string, project: string | undefined, meanwhile: () => void) {
    const { mapsOverview } = await import("@/lib/map-service");
    const gate = Promise.withResolvers<void>();
    let reading = false;
    effects.served.mockImplementationOnce(async (_scope, mapIds) => { reading = true; await gate.promise; return new Map(mapIds.map((id) => [id, null])); });
    const listing = mapsOverview(testAccountScope(db, account), project);
    expect(reading).toBe(true);
    meanwhile();
    gate.resolve();
    return listing;
  }

  it("leaves out a shared map whose membership is revoked while the pictures are read", async () => {
    const { mapsOverview } = await import("@/lib/map-service");
    expect((await mapsOverview(testAccountScope(db, "bob"))).map(m => m.id).sort()).toEqual([shared, ids.bob].sort());
    expect(await heldListing("bob", undefined, removeBob)).toEqual([
      expect.objectContaining({ id: ids.bob, name: "Private bob", layerCount: 1, hasThumbnail: true }),
    ]);
  });

  it("refuses a project narrowing whose project became unreachable meanwhile, as a fresh listing does", async () => {
    const { mapsOverview } = await import("@/lib/map-service");
    expect((await mapsOverview(testAccountScope(db, "bob"), projects.alice)).map(m => m.id)).toEqual([shared]);
    await expect(heldListing("bob", projects.alice, removeBob)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(mapsOverview(testAccountScope(db, "bob"), projects.alice)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("refuses an account deactivated while the pictures are read, whether or not it lists anything", async () => {
    testAccountScope(db, "empty");
    for (const account of ["alice", "empty"]) {
      await expect(heldListing(account, undefined, () => {
        db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(account);
      }), account).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    }
  });
});

it("filters ownership before parsing hidden map and layer content", async () => {
  const { GET } = await import("@/app/api/maps/route");
  db.prepare("UPDATE maps SET widgets = 'unreadable-private-widget' WHERE id = ?").run(ids.bob);
  db.prepare("UPDATE layers SET style = 'unreadable-private-style' WHERE map_id = ?").run(ids.bob);
  const response = await GET(input("alice", "/api/maps"));
  expect(response.status).toBe(200);
  expect((await response.json()).map((map: { id: string }) => map.id)).toEqual([ids.alice]);
});

it("never files a duplicate into a project its owner cannot file in: the copy is unfiled and that project gains nothing", async () => {
  const { duplicateMap } = await import("@/lib/map-service");
  db.prepare("UPDATE maps SET project_id = ? WHERE id = ?").run(projects.bob, ids.alice);
  const filed = () => db.prepare("SELECT id FROM maps WHERE project_id = ? ORDER BY id").all(projects.bob);
  const before = filed();
  const copy = duplicateMap(testAccountScope(db, "alice"), ids.alice);
  expect(copy).toMatchObject({ name: expect.stringMatching(/ copy$/) });
  expect(db.prepare("SELECT owner_id, project_id FROM maps WHERE id = ?").get(copy.id)).toEqual({ owner_id: "alice", project_id: null });
  expect(filed()).toEqual(before);
});
