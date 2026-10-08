import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { retirementsSettled } from "@/lib/ingest/retire";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { creationBaseline } from "@/lib/test-support/creation-baseline";
import * as resolution from "@/lib/publish/publication-resolution";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import { GET as readConfig } from "@/app/api/config/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { POST as createMapRoute } from "@/app/api/maps/route";
import { GET as readMapRoute } from "@/app/api/maps/[id]/route";
import { POST as duplicateMapRoute } from "@/app/api/maps/[id]/duplicate/route";
import { POST as publishMapRoute } from "@/app/api/maps/[id]/publish/route";
import { GET as readPublishedRoute } from "@/app/api/published/[token]/route";

/**
 * Defaults apply to new things only. A map made and published while every
 * default stood at the product's value, with a points, a lines and an
 * areas layer and a sketch, reads the same after an admin changed every
 * default: its stored record and layers, the map as the API reads it, and
 * its published view, assembled afresh for each read rather than served
 * from the publication cache, so a cached view cannot stand in for the
 * path under test. Its basemap and legend corner stay unset in that view,
 * which therefore keeps reading Auto and the reader's own fallback corner.
 * A duplicate made after the change keeps its source's values, while a
 * map made at the same moment takes the changed ones.
 */
const origin = "http://instance.test";
const BASELINE = path.join(process.cwd(), "src/lib/settings/fixtures/creation-baseline.json");
const root = process.env.DEZFIL_DATA_DIR!;

/** Every default an admin can change, none to its product value. */
const EVERY_DEFAULT_CHANGED = {
  "newMap.basemap": "light", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
};
/** What a map's copy never shares with its source: identity, name, times,
 * history, revision and publication. Every other column is compared. */
const MAP_ASIDE = ["id", "name", "publish_token", "published_at", "published_theme", "viewer_controls",
  "created_at", "updated_at", "history_cursor", "edit_revision", "last_changed_at", "last_changed_by"];
const LAYER_ASIDE = ["id", "map_id", "created_at", "updated_at"];

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "existing-maps-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resolution.resetPublishCache(); resetRateLimits();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await retirementsSettled(); resolution.resetPublishCache(); closeMetadataDb(); resetQueryInstance();
  vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
type Params = { params: Promise<{ id: string }> };
const params = (id: string): Params => ({ params: Promise.resolve({ id }) });
const revision = (mapId: string) => String(readDocumentRevision({ kind: "map", id: mapId })!.editRevision);
function request(url: string, method = "GET", body?: unknown, actor = "test-account", headers: Record<string, string> = {}) {
  return testAccountRequest(new Request(origin + url, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), metadataDb(), actor);
}
async function json(response: Response, status: number) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
const aside = (row: Row, columns: string[]) => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

/**
 * The existing map: made through the operations exactly as the capture
 * taken before any default existed (compared with it here, so the map is
 * known to be made under the product's values), then published by its
 * owner.
 */
async function existingPublishedMap(): Promise<{ mapId: string; token: string }> {
  expect(JSON.parse(await creationBaseline())).toEqual(JSON.parse(await readFile(BASELINE, "utf8")));
  const { id: mapId } = metadataDb().prepare("SELECT id FROM maps WHERE name = 'Baseline'").get() as { id: string };
  const { token } = await json(await publishMapRoute(request(`/api/maps/${mapId}/publish`, "POST", undefined, "test-account",
    { "X-Edit-Revision": revision(mapId) }), params(mapId)), 201);
  return { mapId, token };
}

/** An admin changes every default through the change operation, and the
 * runtime read then reports exactly the changed values. */
async function changeEveryDefault() {
  testAccountScope(metadataDb(), "admin");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  await json(await changeInstanceSettings(request("/api/instance/settings", "PATCH", EVERY_DEFAULT_CHANGED, "admin")), 200);
  expect((await json(await readConfig(request("/api/config")), 200)).defaults).toEqual(EVERY_DEFAULT_CHANGED);
}

/** What the map's owner reads: the stored rows and the API's read. */
async function record(mapId: string) {
  const db = metadataDb();
  return {
    map: db.prepare("SELECT * FROM maps WHERE id = ?").get(mapId) as Row,
    layers: db.prepare("SELECT * FROM layers WHERE map_id = ? ORDER BY ordinal").all(mapId) as Row[],
    read: await json(await readMapRoute(request(`/api/maps/${mapId}`), params(mapId)), 200),
  };
}

/**
 * The published view as an anonymous reader receives it, assembled for
 * this read: the publication cache is emptied first and the read is seen
 * to run the assembly, which also leaves the view it assembled held.
 */
async function publishedAfresh(token: string) {
  resolution.resetPublishCache();
  expect(resolution.publicationViewsForTests()).toEqual([]);
  const resolve = resolution.resolvePublishedView;
  let assemblies = 0;
  const watched = vi.spyOn(resolution, "resolvePublishedView").mockImplementation((asked, now, assemble) =>
    resolve(asked, now, snapshot => { assemblies += 1; return assemble(snapshot); }));
  try {
    const view = await json(await readPublishedRoute(socketRequest(new Request(`${origin}/api/published/${token}`)),
      { params: Promise.resolve({ token }) }), 200);
    expect(assemblies).toBeGreaterThan(0);
    expect(resolution.publicationViewsForTests()).toEqual([token]);
    return view;
  } finally { watched.mockRestore(); }
}

describe("a map made before every default changed", () => {
  it("keeps its stored record and layers, and reads the same through the API", async () => {
    const { mapId } = await existingPublishedMap();
    const before = await record(mapId);
    expect(before.map).toMatchObject({ basemap: null, legend_corner: null, view_lat: 40, view_lng: 0, view_zoom: 1.3 });
    expect(before.layers.map(layer => layer.name)).toEqual(["Points", "Lines", "Areas", "Sketch"]);
    await changeEveryDefault();
    expect(await record(mapId)).toEqual(before);
  }, 60_000);

  it("answers its published view assembled afresh exactly as before, its basemap and legend corner still unset", async () => {
    const { token } = await existingPublishedMap();
    const before = await publishedAfresh(token);
    expect(before).toMatchObject({ basemapKey: null, customBasemap: null, legendCorner: null });
    // Every layer drawn, so the comparison below is over content, never
    // over two equally failed renders.
    expect(before.layers.map((layer: { name: string; render: { ok: boolean; featureCount?: number } }) =>
      [layer.name, layer.render.ok, layer.render.featureCount])).toEqual([
      ["Points", true, 1], ["Lines", true, 1], ["Areas", true, 1], ["Sketch", true, 1]]);
    await changeEveryDefault();
    const after = await publishedAfresh(token);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ basemapKey: null, customBasemap: null, legendCorner: null });
  }, 60_000);

  it("gives a later duplicate its source's values, while a map made at the same moment takes the changed ones", async () => {
    const { mapId } = await existingPublishedMap();
    await changeEveryDefault();
    const copy = await json(await duplicateMapRoute(request(`/api/maps/${mapId}/duplicate`, "POST"), params(mapId)), 201);
    const fresh = await json(await createMapRoute(request("/api/maps", "POST", { name: "Fresh" })), 201);
    const [source, duplicate, made] = await Promise.all([mapId, String(copy.id), String(fresh.id)].map(record));
    expect(aside(duplicate.map, MAP_ASIDE)).toEqual(aside(source.map, MAP_ASIDE));
    expect(duplicate.layers.map(layer => aside(layer, LAYER_ASIDE))).toEqual(source.layers.map(layer => aside(layer, LAYER_ASIDE)));
    expect(duplicate.map).toMatchObject({ name: "Baseline copy", basemap: null, legend_corner: null, view_lat: 40, view_lng: 0, view_zoom: 1.3 });
    expect(made.map).toMatchObject({ basemap: "light", legend_corner: "top-right", view_lat: -33.8688, view_lng: 151.2093, view_zoom: 9.75 });
  }, 60_000);
});
