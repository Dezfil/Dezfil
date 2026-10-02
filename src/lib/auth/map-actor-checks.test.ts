import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { updateMap } from "@/lib/map-service";
import { undoChange } from "@/lib/map-history";
import { defaultStyle } from "@/lib/style/defaults";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { PERMISSION_REFUSAL } from "./reach";

/**
 * Who may write to a map, its layers, widgets and history.
 *
 * Pat owns project P; Ada (an editor of P) owns map M, filed in P and
 * published, and an unfiled map U; Ed is an editor of P, Vi a viewer, and Out
 * an admin who belongs to nothing. The people rows are written directly: no
 * route adds them yet, and every read is still the owner's alone.
 *
 * Content changes, sketches drawn on the map included, are for the owner, the
 * project's owner and an editor; deletion, publication settings and browser
 * captures stay the owner's. A viewer is refused by the permission shape and a non-member by the
 * absent shape, alike across session and token, with nothing changed.
 */
const effects = vi.hoisted(() => ({
  geometry: vi.fn(async () => ({ geometryType: "POINT" })),
  query: vi.fn(async () => { throw new Error("Unexpected query"); }),
  inspect: vi.fn(async () => ({ url: "https://styles.example.test/style.json", name: null, attribution: [] })),
  thumbnail: vi.fn(async () => {}), tiles: vi.fn(async () => {}),
  admit: vi.fn(async () => ({ bound: [] })),
}));
vi.mock("@/lib/layer-geometry", () => ({ inspectLayerGeometry: effects.geometry }));
vi.mock("@/lib/query/bounded", async original => ({ ...await original<object>(), boundedEvaluation: effects.query }));
vi.mock("@/lib/basemap-custom", () => ({ resolveCustomBasemapWrite: effects.inspect }));
vi.mock("@/lib/map-thumbnails", async original => ({ ...await original<object>(), prepareThumbnailRemoval: () => effects.thumbnail,
  saveThumbnail: effects.thumbnail, saveThemedThumbnail: effects.thumbnail, removeThumbnail: effects.thumbnail, copyThumbnail: effects.thumbnail }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles }));
// What a non-owner's SQL may name is its own suite (editor-admission); here it
// is admitted, and never asked before a refusal.
vi.mock("@/lib/save-admission", async original => ({ ...await original<object>(), admitMapSql: effects.admit }));

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "ed", "vi", "out"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  const style = JSON.stringify(defaultStyle(null));
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, publish_token, published_at)
      VALUES ('M', 'Shared map', '${now}', '${now}', 'ada', 'P', 'token-shared-map-000000', '${now}'),
             ('U', 'Unfiled map', '${now}', '${now}', 'ada', NULL, NULL, NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at, published_fields)
      VALUES ('L', 'M', 'Roads', 'SELECT 1 AS v', '${style}', 0, '${now}', '${now}', '["v"]'),
             ('UL', 'U', 'Roads', 'SELECT 1 AS v', '${style}', 0, '${now}', '${now}', NULL);`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function input(account: string, path: string, method: string, body?: unknown, kind = "session") {
  const raw = body instanceof Uint8Array;
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method,
    headers: { "content-type": raw ? "image/png" : "application/json" },
    ...(body === undefined ? {} : { body: raw ? (body as unknown as BodyInit) : JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Writes", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() {
  return ["maps", "layers", "map_history", "projects", "project_people", "data_tables"]
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const scope = (account: string) => testAccountScope(db, account);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const route = {
  map: () => import("@/app/api/maps/[id]/route"),
  layers: () => import("@/app/api/maps/[id]/layers/route"),
  layer: () => import("@/app/api/layers/[id]/route"),
  duplicateLayer: () => import("@/app/api/layers/[id]/duplicate/route"),
  publish: () => import("@/app/api/maps/[id]/publish/route"),
  thumbnail: () => import("@/app/api/maps/[id]/thumbnail/route"),
  undo: () => import("@/app/api/maps/[id]/undo/route"),
  redo: () => import("@/app/api/maps/[id]/redo/route"),
  sketches: () => import("@/app/api/maps/[id]/sketches/route"),
};
interface Case {
  label: string;
  action: "edit" | "publish" | "delete" | "capture" | "sketch";
  method: string;
  target: "map" | "layer";
  suffix: (id: string) => string;
  body?: unknown;
  load: () => Promise<Record<string, unknown>>;
  status: number;
  /** State the case needs before it runs, made by the owner. */
  setup?: () => Promise<void>;
  /** What the change left, read back after a permitted write. */
  effect?: () => unknown;
  expected?: unknown;
  ownerOnlySuccess?: boolean;
}
const value = (sql: string) => Object.values(db.prepare(sql).get() as object)[0];
const cases: Case[] = [
  { label: "rename the map", action: "edit", method: "PATCH", target: "map", suffix: id => `/api/maps/${id}`, body: { name: "Renamed" },
    load: route.map, status: 200, effect: () => value("SELECT name FROM maps WHERE id = 'M'"), expected: "Renamed" },
  { label: "move the camera", action: "edit", method: "PATCH", target: "map", suffix: id => `/api/maps/${id}`,
    body: { viewport: { lng: 13.4, lat: 52.5, zoom: 9 } }, load: route.map, status: 200,
    effect: () => value("SELECT view_zoom FROM maps WHERE id = 'M'"), expected: 9 },
  { label: "move the legend", action: "edit", method: "PATCH", target: "map", suffix: id => `/api/maps/${id}`, body: { legendCorner: "top-right" },
    load: route.map, status: 200, effect: () => value("SELECT legend_corner FROM maps WHERE id = 'M'"), expected: "top-right" },
  { label: "set a custom basemap", action: "edit", method: "PATCH", target: "map", suffix: id => `/api/maps/${id}`,
    body: { customBasemap: { url: "https://styles.example.test/style.json" } }, load: route.map, status: 200,
    effect: () => value("SELECT json_extract(custom_basemap, '$.url') FROM maps WHERE id = 'M'"), expected: "https://styles.example.test/style.json" },
  { label: "turn widget publication off", action: "publish", method: "PATCH", target: "map", suffix: id => `/api/maps/${id}`,
    body: { widgetsPublished: false }, load: route.map, status: 200, effect: () => value("SELECT widgets_published FROM maps WHERE id = 'M'"), expected: 0 },
  { label: "rename the layer and hide it", action: "edit", method: "PATCH", target: "layer", suffix: id => `/api/layers/${id}`,
    body: { name: "Streets", visible: false }, load: route.layer, status: 200,
    effect: () => db.prepare("SELECT name, visible FROM layers WHERE id = 'L'").get(), expected: { name: "Streets", visible: 0 } },
  { label: "change the published fields", action: "publish", method: "PATCH", target: "layer", suffix: id => `/api/layers/${id}`,
    body: { publishedFields: null }, load: route.layer, status: 200, effect: () => value("SELECT published_fields FROM layers WHERE id = 'L'"), expected: null },
  { label: "add a layer", action: "edit", method: "POST", target: "map", suffix: id => `/api/maps/${id}/layers`, body: { name: "Added", sql: "SELECT 2 AS w" },
    load: route.layers, status: 201, effect: () => value("SELECT count(*) FROM layers WHERE map_id = 'M'"), expected: 2 },
  { label: "duplicate a layer", action: "edit", method: "POST", target: "layer", suffix: id => `/api/layers/${id}/duplicate`, body: {},
    load: route.duplicateLayer, status: 201, effect: () => value("SELECT count(*) FROM layers WHERE map_id = 'M'"), expected: 2 },
  { label: "remove a layer", action: "edit", method: "DELETE", target: "layer", suffix: id => `/api/layers/${id}`,
    load: route.layer, status: 200, effect: () => value("SELECT count(*) FROM layers WHERE map_id = 'M'"), expected: 0 },
  { label: "undo a content change", action: "edit", method: "POST", target: "map", suffix: id => `/api/maps/${id}/undo`, load: route.undo, status: 200,
    setup: async () => { updateMap(scope("ada"), "M", { name: "Changed by the owner" }); },
    effect: () => value("SELECT name FROM maps WHERE id = 'M'"), expected: "Shared map" },
  { label: "redo a content change", action: "edit", method: "POST", target: "map", suffix: id => `/api/maps/${id}/redo`, load: route.redo, status: 200,
    setup: async () => { updateMap(scope("ada"), "M", { name: "Changed by the owner" }); await undoChange(scope("ada"), "M"); },
    effect: () => value("SELECT name FROM maps WHERE id = 'M'"), expected: "Changed by the owner" },
  { label: "undo a widget publication change", action: "publish", method: "POST", target: "map", suffix: id => `/api/maps/${id}/undo`, load: route.undo, status: 200,
    setup: async () => { updateMap(scope("ada"), "M", { widgetsPublished: false }); },
    effect: () => value("SELECT widgets_published FROM maps WHERE id = 'M'"), expected: 1 },
  { label: "redo a published-fields change", action: "publish", method: "POST", target: "map", suffix: id => `/api/maps/${id}/redo`, load: route.redo, status: 200,
    setup: async () => {
      const { updateLayer } = await import("@/lib/layer-service");
      await updateLayer(scope("ada"), "L", { publishedFields: null });
      await undoChange(scope("ada"), "M");
    },
    effect: () => value("SELECT published_fields FROM layers WHERE id = 'L'"), expected: null },
  { label: "publish with a theme", action: "publish", method: "POST", target: "map", suffix: id => `/api/maps/${id}/publish`, body: { theme: "light" },
    load: route.publish, status: 201, effect: () => value("SELECT published_theme FROM maps WHERE id = 'M'"), expected: "light" },
  { label: "unpublish", action: "publish", method: "DELETE", target: "map", suffix: id => `/api/maps/${id}/publish`, load: route.publish, status: 200,
    effect: () => value("SELECT publish_token FROM maps WHERE id = 'M'"), expected: null },
  { label: "store a browser capture", action: "capture", method: "PUT", target: "map", suffix: id => `/api/maps/${id}/thumbnail`, body: png,
    load: route.thumbnail, status: 204, effect: () => effects.thumbnail.mock.calls.length, expected: 1 },
  { label: "draw a sketch", action: "sketch", method: "POST", target: "map", suffix: id => `/api/maps/${id}/sketches`,
    body: { feature: { kind: "point", geometry: { type: "Point", coordinates: [13.4, 52.5] } } }, load: route.sketches, status: 201,
    ownerOnlySuccess: false },
  { label: "delete the map", action: "delete", method: "DELETE", target: "map", suffix: id => `/api/maps/${id}`, load: route.map, status: 204,
    effect: () => value("SELECT count(*) FROM maps WHERE id = 'M'"), expected: 0 },
];
const permitted = (action: Case["action"]) => action === "edit" || action === "sketch" ? ["ada", "pat", "ed"] : ["ada"];
const target = (c: Case, map: string) => (c.target === "map" ? map : map === "M" ? "L" : map === "U" ? "UL" : "missing");
async function call(c: Case, account: string, id: string, kind = "session") {
  const handler = (await c.load())[c.method] as Handler;
  return handler(input(account, c.suffix(id), c.method, c.body, kind), { params: Promise.resolve({ id }) });
}
async function refusal(c: Case, account: string, id: string, missing: string) {
  const before = snapshot();
  const session = await call(c, account, id), token = await call(c, account, id, "token");
  const absent = await call(c, account, missing);
  const parsed = { session: { status: session.status, body: await session.json() }, token: { status: token.status, body: await token.json() },
    absent: { status: absent.status, body: await absent.json() } };
  expect(snapshot()).toEqual(before);
  expect(effects.inspect).not.toHaveBeenCalled();
  expect(effects.thumbnail).not.toHaveBeenCalled();
  expect(effects.tiles).not.toHaveBeenCalled();
  expect(effects.query).not.toHaveBeenCalled();
  expect(effects.admit).not.toHaveBeenCalled();
  return parsed;
}

describe.each(cases)("$label", c => {
  for (const account of ["pat", "ed", "vi"].filter(name => !permitted(c.action).includes(name))) {
    it(`refuses ${account} by the permission shape, alike across session and token, with nothing changed`, async () => {
      await c.setup?.(); vi.clearAllMocks();
      const { session, token } = await refusal(c, account, target(c, "M"), target(c, "missing"));
      expect(session).toEqual({ status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } });
      expect(token).toEqual(session);
    });
  }
  it("refuses an outsider and an admin by the absent shape, alike across session and token, with nothing changed", async () => {
    await c.setup?.(); vi.clearAllMocks();
    const { session, token, absent } = await refusal(c, "out", target(c, "M"), target(c, "missing"));
    expect(session).toEqual({ status: 404, body: absent.body });
    expect(session.body.error.code).toBe("not_found");
    expect(token).toEqual(session);
  });
  it("refuses the project's people on the owner's unfiled map by the absent shape", async () => {
    for (const account of ["pat", "ed", "vi"]) {
      const { session, absent } = await refusal(c, account, target(c, "U"), target(c, "missing"));
      expect(session).toEqual({ status: 404, body: absent.body });
    }
  });
  if (c.ownerOnlySuccess !== false) {
    for (const account of permitted(c.action)) {
      it(`lets ${account} make it`, async () => {
        await c.setup?.(); vi.clearAllMocks();
        const response = await call(c, account, target(c, "M"));
        expect(response.status, JSON.stringify(await response.clone().json().catch(() => null))).toBe(c.status);
        expect(c.effect?.()).toEqual(c.expected);
      });
    }
  }
});

describe("the resource-owner freeze", () => {
  it("makes a deactivated owner's map read-only for everyone who still reaches it", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    for (const c of cases.filter(entry => entry.action === "edit" && !entry.setup)) {
      for (const account of ["pat", "ed", "vi"]) {
        const { session, token } = await refusal(c, account, target(c, "M"), target(c, "missing"));
        expect(session, `${c.label} ${account}`).toEqual({ status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } });
        expect(token).toEqual(session);
      }
    }
  });
});

describe("the write response for someone else's map", () => {
  it("names the project the editor reaches it through, and answers as the editor's own read of the map does", async () => {
    const response = await call(cases[0], "ed", "M");
    const written = await response.json() as Record<string, unknown>;
    expect(written).toMatchObject({ id: "M", name: "Renamed", projectId: "P", home: "ada" });
    const { GET } = await route.map();
    const read = await GET(input("ed", "/api/maps/M", "GET"), { params: Promise.resolve({ id: "M" }) });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(written);
  });
});
