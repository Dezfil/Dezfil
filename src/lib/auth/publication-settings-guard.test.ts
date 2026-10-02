import { withFixtureRevision } from "@/lib/test-support/edit-basis";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
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
 * The publication settings, on every path that can change them.
 *
 * Pat owns project P; Ada, an editor of P, owns map M, filed in P and
 * published with a theme and a reader-control set, and map N, filed in P and
 * not published. Ed is an editor of P and Vi a viewer.
 *
 * The token, the published field selection, the widget publication toggle,
 * the publication theme and the reader controls change only by the map's
 * owner: through the publish operations, through ordinary map and layer
 * writes that carry them, and through undo and redo. For an editor, the
 * project's owner acting as one, and a viewer, every write that would change
 * one is refused whole with the permission refusal, byte-equal across session
 * and token, with every row as it was. The owner's own changes land.
 */
const effects = vi.hoisted(() => ({
  geometry: vi.fn(async () => ({ geometryType: "POINT" })),
  query: vi.fn(async () => { throw new Error("Unexpected query"); }),
  admit: vi.fn(async () => ({ bound: [] })),
}));
vi.mock("@/lib/layer-geometry", () => ({ inspectLayerGeometry: effects.geometry }));
vi.mock("@/lib/query/bounded", async original => ({ ...await original<object>(), boundedEvaluation: effects.query }));
vi.mock("@/lib/save-admission", async original => ({ ...await original<object>(), admitMapSql: effects.admit }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: vi.fn(async () => {}) }));

let db: Database;
const now = "2026-01-01T00:00:00.000Z";
const widget = { id: "w1", type: "formula", layerId: "L", title: "Count", field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true };
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "ada", "ed", "vi"]) testAccountScope(db, id);
  const style = JSON.stringify(defaultStyle(null));
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, publish_token, published_at, published_theme, viewer_controls, widgets)
      VALUES ('M', 'Shared map', '${now}', '${now}', 'ada', 'P', 'token-shared-map-000000', '${now}', 'dark',
        '{"tilt":false,"fit":true,"theme":true,"basemap":true,"coords":true}', '${JSON.stringify([widget])}'),
             ('N', 'Draft map', '${now}', '${now}', 'ada', 'P', NULL, NULL, NULL, NULL, '[]');
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at, published_fields)
      VALUES ('L', 'M', 'Roads', 'SELECT 1 AS v', '${style}', 0, '${now}', '${now}', '["v"]');`);
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const scope = (account: string) => testAccountScope(db, account);
function input(account: string, path: string, method: string, body?: unknown, kind = "session") {
  const request = testAccountRequest(new Request(`http://instance.test${path}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Publication", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
/** Every row a publication setting or its history lives in. */
function snapshot() {
  return ["maps", "layers", "map_history"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const settings = () => db.prepare(`SELECT m.publish_token AS token, m.published_theme AS theme, m.viewer_controls AS controls,
  m.widgets_published AS widgets, l.published_fields AS fields FROM maps m LEFT JOIN layers l ON l.map_id = m.id WHERE m.id = ?`);
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const route = {
  map: () => import("@/app/api/maps/[id]/route"),
  layer: () => import("@/app/api/layers/[id]/route"),
  publish: () => import("@/app/api/maps/[id]/publish/route"),
  undo: () => import("@/app/api/maps/[id]/undo/route"),
  redo: () => import("@/app/api/maps/[id]/redo/route"),
};
interface Case {
  field: "token" | "theme" | "reader controls" | "widget publication" | "published fields";
  path: string;
  load: () => Promise<Record<string, unknown>>;
  method: string;
  url: (id: string) => string;
  id: string;
  body?: unknown;
  /** History the owner made first, for a replay to restore. */
  setup?: () => Promise<void>;
  /** The setting as the owner's own change leaves it. */
  owned: Record<string, unknown>;
}
const layerPatch = (body: unknown): Pick<Case, "load" | "method" | "url" | "id" | "body"> =>
  ({ load: route.layer, method: "PATCH", url: id => `/api/layers/${id}`, id: "L", body });
const mapPatch = (body: unknown): Pick<Case, "load" | "method" | "url" | "id" | "body"> =>
  ({ load: route.map, method: "PATCH", url: id => `/api/maps/${id}`, id: "M", body });
const replay = (direction: "undo" | "redo"): Pick<Case, "load" | "method" | "url" | "id"> =>
  ({ load: route[direction], method: "POST", url: id => `/api/maps/${id}/${direction}`, id: "M" });
async function changeFields(fields: string[] | null) {
  const { updateLayer } = await import("@/lib/layer-service");
  await updateLayer(scope("ada"), "L", { publishedFields: fields });
}
const cases: Case[] = [
  { field: "token", path: "publish (mint)", load: route.publish, method: "POST", url: id => `/api/maps/${id}/publish`, id: "N",
    owned: { token: expect.any(String) } },
  { field: "token", path: "unpublish (revoke)", load: route.publish, method: "DELETE", url: id => `/api/maps/${id}/publish`, id: "M",
    owned: { token: null } },
  { field: "theme", path: "publish", load: route.publish, method: "POST", url: id => `/api/maps/${id}/publish`, id: "M",
    body: { theme: "light" }, owned: { theme: "light" } },
  { field: "reader controls", path: "publish", load: route.publish, method: "POST", url: id => `/api/maps/${id}/publish`, id: "M",
    body: { viewerControls: { tilt: true } }, owned: { controls: '{"tilt":true,"fit":true,"theme":true,"basemap":true,"coords":true}' } },
  { field: "widget publication", path: "map write", ...mapPatch({ widgetsPublished: false }), owned: { widgets: 0 } },
  { field: "widget publication", path: "widget write", ...mapPatch({ widgets: [{ ...widget, title: "Total" }], widgetsPublished: false }),
    owned: { widgets: 0 } },
  { field: "widget publication", path: "map write with a rename", ...mapPatch({ name: "Renamed", widgetsPublished: false }), owned: { widgets: 0 } },
  { field: "widget publication", path: "undo", ...replay("undo"), setup: async () => { updateMap(scope("ada"), "M", { widgetsPublished: false }, { expectedRevision: readEditRevision({ kind: "map", id: "M" })?.editRevision }); },
    owned: { widgets: 1 } },
  { field: "widget publication", path: "redo", ...replay("redo"),
    setup: async () => { updateMap(scope("ada"), "M", { widgetsPublished: false }, { expectedRevision: readEditRevision({ kind: "map", id: "M" })?.editRevision }); await undoChange(scope("ada"), "M"); }, owned: { widgets: 0 } },
  { field: "widget publication", path: "undo of a grouped rename", ...replay("undo"),
    setup: async () => { updateMap(scope("ada"), "M", { name: "Renamed", widgetsPublished: false }, { expectedRevision: readEditRevision({ kind: "map", id: "M" })?.editRevision }); }, owned: { widgets: 1 } },
  { field: "published fields", path: "layer write", ...layerPatch({ publishedFields: null }), owned: { fields: null } },
  { field: "published fields", path: "layer write with a rename", ...layerPatch({ name: "Streets", publishedFields: [] }), owned: { fields: "[]" } },
  { field: "published fields", path: "undo", ...replay("undo"), setup: () => changeFields(null), owned: { fields: '["v"]' } },
  { field: "published fields", path: "redo", ...replay("redo"),
    setup: async () => { await changeFields(null); await undoChange(scope("ada"), "M"); }, owned: { fields: null } },
];
async function call(c: Case, account: string, kind = "session", basis?: string | null) {
  const handler = (await c.load())[c.method] as Handler;
  const response = await handler(withFixtureRevision(input(account, c.url(c.id), c.method, c.body, kind), basis), { params: Promise.resolve({ id: c.id }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };

describe.each(cases)("$field through $path", c => {
  for (const account of ["ed", "pat", "vi"]) {
    it(`is refused whole for ${account}, alike across session and token, with nothing changed`, async () => {
      await c.setup?.(); vi.clearAllMocks();
      const before = snapshot();
      const session = await call(c, account), token = await call(c, account, "token");
      expect(session).toEqual(forbidden);
      expect(token).toEqual(session);
      expect(snapshot()).toEqual(before);
      expect(effects.query).not.toHaveBeenCalled();
      expect(effects.admit).not.toHaveBeenCalled();
    });
  }
  it("is the owner's to change", async () => {
    await c.setup?.();
    const response = await call(c, "ada", "session", readEditRevision({ kind: "map", id: c.id === "L" ? "M" : c.id })?.editRevision);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(settings().get(c.id === "L" ? "M" : c.id)).toMatchObject(c.owned);
  });
});

describe("an ordinary map write naming the token, the theme or the reader controls", () => {
  it("changes none of them, for the owner or anyone else", async () => {
    const before = snapshot();
    for (const account of ["ada", "ed", "pat"]) {
      const response = await call({ ...mapPatch({ publishToken: "forged-token-0000000000", publishedAt: now, theme: "light",
        publishedTheme: "light", viewerControls: { tilt: true } }), field: "token", path: "map write", owned: {} }, account);
      expect(response.status, account).toBe(200);
    }
    expect(snapshot()).toEqual(before);
  });
});
