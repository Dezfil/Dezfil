import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";

const effects = vi.hoisted(() => ({ query: vi.fn(async () => { throw new Error("Unexpected protected query"); }),
  geometry: vi.fn(async () => ({ geometryType: "POINT" })), tiles: vi.fn(async () => {}), readTile: vi.fn(async () => null) }));
vi.mock("@/lib/query/bounded", async original => ({ ...await original<object>(), boundedEvaluation: effects.query }));
vi.mock("@/lib/layer-geometry", () => ({ inspectLayerGeometry: effects.geometry }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles }));
vi.mock("@/lib/tiles/serve", () => ({ readTile: effects.readTile }));
let db: Database;
let maps: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  maps = {};
  for (const account of accounts) {
    maps[account] = createMap(testAccountScope(db, account), `Private ${account}`).id;
    db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, ?, 'SELECT 1 AS secret', ?, 0, 'time', 'time')`).run(`layer-${account}`, maps[account], `Secret ${account}`, JSON.stringify(defaultStyle(null)));
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Layers", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() { return ["maps", "layers", "map_history"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()); }
const cases = [
  ["read", "GET", "", undefined, () => import("@/app/api/layers/[id]/route")],
  ["edit", "PATCH", "", { name: "Changed", sql: "SELECT 2 AS secret" }, () => import("@/app/api/layers/[id]/route")],
  ["delete", "DELETE", "", undefined, () => import("@/app/api/layers/[id]/route")],
  ["duplicate", "POST", "/duplicate", {}, () => import("@/app/api/layers/[id]/duplicate/route")],
  ["fields", "GET", "/fields", undefined, () => import("@/app/api/layers/[id]/fields/route")],
  ["statistics", "GET", "/fields/secret", undefined, () => import("@/app/api/layers/[id]/fields/[field]/route")],
  ["render", "GET", "/render", undefined, () => import("@/app/api/layers/[id]/render/route")],
  ["filtered render", "POST", "/render", { selections: [] }, () => import("@/app/api/layers/[id]/render/route")],
  ["slider", "GET", "/slider-preview", undefined, () => import("@/app/api/layers/[id]/slider-preview/route")],
  ["fill", "POST", "/fill", { attribute: "secret", method: "quantile", classes: 3 }, () => import("@/app/api/layers/[id]/fill/route")],
  ["scale", "POST", "/scale", { attribute: "secret", range: [1, 10], unit: "px" }, () => import("@/app/api/layers/[id]/scale/route")],
  ["extent", "POST", "/extent", { dims: [] }, () => import("@/app/api/layers/[id]/extent/route")],
  ["export", "GET", "/export/csv", undefined, () => import("@/app/api/layers/[id]/export/[format]/route")],
  ["tiles", "GET", "/tiles/0/0/0", undefined, () => import("@/app/api/layers/[id]/tiles/[z]/[x]/[y]/route")],
] as const;
type Handler = (request: Request, context: { params: Promise<{ id: string; field: string; format: string; z: string; x: string; y: string }> }) => Promise<Response>;
function context(id: string) { return { params: Promise.resolve({ id, field: "secret", format: "csv", z: "0", x: "0", y: "0" }) }; }
it.each(cases)("refuses hidden %s before query, mutation or artifact access", async (_label, method, suffix, body, load) => {
  const handler = (await load() as unknown as Record<string, Handler>)[method];
  const before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const hidden = await handler(input(account, `/api/layers/layer-${other}${suffix}`, method, body, kind), context(`layer-${other}`));
    const absent = await handler(input(account, `/api/layers/missing${suffix}`, method, body, kind), context("missing"));
    expect(hidden.status).toBe(404); expect(absent.status).toBe(404);
    const payload = await hidden.json(); expect(payload).toEqual(await absent.json());
    expect(JSON.stringify(payload)).not.toMatch(/Private|Secret|alice|bob|admin|SELECT/);
    expect(snapshot()).toEqual(before);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  }
});
it.each(["GET", "POST"])("refuses another owner's parent on layer collection %s before evaluation", async method => {
  const route = await import("@/app/api/maps/[id]/layers/route");
  const handler = method === "GET" ? route.GET : route.POST;
  const before = snapshot();
  const responses = [];
  for (const id of [maps.bob, "missing"]) responses.push(await handler(input("alice", `/api/maps/${id}/layers`, method,
    method === "POST" ? { name: "New", sql: "SELECT 1" } : undefined), context(id)));
  expect(responses.map(r => r.status)).toEqual([404, 404]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect(snapshot()).toEqual(before); expect(effects.geometry).not.toHaveBeenCalled();
});
function widget(layerId: string, id = "draft") { return { id, type: "formula", layerId, title: "Count", field: null,
  agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }; }
it.each(["widgets", "timeline", "layerOrder", "legendOrder", "preview"])("refuses hidden and absent %s references before any evaluation or write", async field => {
  const { PATCH } = await import("@/app/api/maps/[id]/route");
  const { POST } = await import("@/app/api/maps/[id]/widget-values/route");
  const before = snapshot(); const responses = [];
  for (const layerId of ["layer-bob", "missing"]) {
    const body = field === "preview" ? { draft: widget(layerId) } : field === "widgets" ? { widgets: [widget("layer-alice", "own"), widget(layerId)] }
      : field === "timeline" ? { timeline: { layerId, field: "time" } } : { [field]: [layerId] };
    responses.push(await (field === "preview" ? POST : PATCH)(input("alice", `/api/maps/${maps.alice}`, field === "preview" ? "POST" : "PATCH", body), context(maps.alice)));
  }
  expect(responses.map(r => r.status)).toEqual([404, 404]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect(snapshot()).toEqual(before); expect(effects.query).not.toHaveBeenCalled();
});
it("checks the exact parent even when both maps belong to the caller", async () => {
  const second = createMap(testAccountScope(db, "alice"), "Second");
  const { PATCH } = await import("@/app/api/maps/[id]/route");
  const before = snapshot();
  expect((await PATCH(input("alice", `/api/maps/${second.id}`, "PATCH", { widgets: [widget("layer-alice")] }), context(second.id))).status).toBe(404);
  expect(snapshot()).toEqual(before); expect(effects.query).not.toHaveBeenCalled();
});
it("preserves each owner's layer create, read, edit, duplicate and delete loop", async () => {
  const { POST } = await import("@/app/api/maps/[id]/layers/route");
  const { GET, PATCH, DELETE } = await import("@/app/api/layers/[id]/route");
  const { POST: duplicate } = await import("@/app/api/layers/[id]/duplicate/route");
  for (const account of accounts) {
    const created = await POST(input(account, `/api/maps/${maps[account]}/layers`, "POST", { name: "Own", sql: "SELECT 1" }), context(maps[account]));
    expect(created.status).toBe(201); const layer = await created.json();
    expect((await GET(input(account, `/api/layers/${layer.id}`), context(layer.id))).status).toBe(200);
    expect((await PATCH(input(account, `/api/layers/${layer.id}`, "PATCH", { name: "Edited" }), context(layer.id))).status).toBe(200);
    expect((await duplicate(input(account, `/api/layers/${layer.id}/duplicate`, "POST", {}), context(layer.id))).status).toBe(201);
    expect((await DELETE(input(account, `/api/layers/${layer.id}`, "DELETE"), context(layer.id))).status).toBe(204);
  }
});
it("requires explicit service scopes and refuses hidden identities before work", async () => {
  const service = await import("@/lib/layer-service");
  const removal = await import("@/lib/layer-removal");
  type Scope = ReturnType<typeof testAccountScope>;
  const call = (fn: unknown, ...args: unknown[]) => (fn as (...values: unknown[]) => unknown)(...args);
  const actions = (scope: Scope, layerId: string, mapId: string) => [
    () => call(service.requireLayer, scope, layerId), () => call(service.updateLayer, scope, layerId, { name: "Changed" }),
    () => call(service.duplicateLayer, scope, layerId), () => call(removal.removeLayer, scope, layerId),
    () => call(service.createLayer, scope, mapId, { name: "New", sql: "SELECT 1" }),
  ];
  const before = snapshot();
  for (const value of [undefined, null, { accountId: "alice" }]) for (const action of actions(value as Scope, "layer-alice", maps.alice)) {
    await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  }
  for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    for (const action of actions(testAccountScope(db, account), `layer-${other}`, maps[other])) {
      await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  }
  expect(snapshot()).toEqual(before); for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
});
it.each(["create", "edit"])("rechecks activity after asynchronous %s geometry inspection", async action => {
  const { POST } = await import("@/app/api/maps/[id]/layers/route");
  const { PATCH } = await import("@/app/api/layers/[id]/route");
  const before = snapshot();
  effects.geometry.mockImplementationOnce(async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    return { geometryType: "POINT" };
  });
  const id = action === "create" ? maps.alice : "layer-alice";
  const response = await (action === "create" ? POST : PATCH)(input("alice", "/api/layers", action === "create" ? "POST" : "PATCH", { name: "Late", sql: "SELECT 2 AS secret" }), context(id));
  expect(response.status).toBe(401); expect(snapshot()).toEqual(before);
  db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  const { GET } = await import("@/app/api/layers/[id]/route");
  expect((await GET(input("alice", "/api/layers/layer-alice"), context("layer-alice"))).status).toBe(200);
});
it("selects parent ownership before decoding hidden layer content", async () => {
  db.prepare("UPDATE layers SET style = 'unreadable-private-style' WHERE id = 'layer-bob'").run();
  const { GET } = await import("@/app/api/layers/[id]/route");
  expect((await GET(input("alice", "/api/layers/layer-bob"), context("layer-bob"))).status).toBe(404);
});
it("refuses widget service calls without scope or with hidden parents before evaluating", async () => {
  const { privateWidgetValues } = await import("@/lib/private-widget-service");
  type Scope = Parameters<typeof privateWidgetValues>[0];
  for (const scope of [undefined, null, { accountId: "alice" }]) {
    await expect(privateWidgetValues(scope as Scope, maps.alice, [])).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  }
  for (const id of [maps.bob, "missing"]) {
    await expect(privateWidgetValues(testAccountScope(db, "alice"), id, [])).rejects.toMatchObject({ code: "not_found", status: 404 });
  }
  expect(effects.query).not.toHaveBeenCalled();
});
