import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { retirementsSettled } from "@/lib/ingest/retire";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { declaredRevisionArguments } from "@/lib/edit-basis";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { POST as createMap } from "@/app/api/maps/route";
import { POST as createLayer } from "@/app/api/maps/[id]/layers/route";
import { POST as createSketch } from "@/app/api/maps/[id]/sketches/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";

/**
 * A new layer created without a style takes the instance's layer defaults:
 * the next color of the color cycle, its geometry's opacity, the line
 * width and the point radius. A layer created with a style keeps it. A
 * sketch layer takes the cycle's color alone and keeps its own style.
 * Every expected style below is written out, never derived from the code
 * under test.
 */
const origin = "http://instance.test";
const root = process.env.DEZFIL_DATA_DIR!;

/** Every layer default an admin can change, none at the product's value. */
const LAYER_DEFAULTS = {
  "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10, "newLayer.lineOpacity": 100,
  "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
};
/** Tab10, in its order: the colors layers 0 to 5 take in turn. */
const TAB10 = [[31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40], [148, 103, 189], [140, 86, 75]]
  .map(([r, g, b]) => ({ r, g, b, a: 1 }));
const DARK_STROKE = { r: 12, g: 16, b: 24, a: 1 };
const constant = (color: object) => ({ type: "constant", color });
const POINTS = (i: number) => ({ fill: constant(TAB10[i]), fillOpacity: 0.1, stroke: DARK_STROKE, strokeOpacity: 0.85, strokeWidth: 0, pointRadius: 12.5, opacity: 1 });
const LINES = (i: number) => ({ fill: constant(TAB10[i]), fillOpacity: 0.1, stroke: TAB10[i], strokeOpacity: 1, strokeWidth: 0.5, pointRadius: 12.5, opacity: 1 });
const AREAS = (i: number) => ({ fill: constant(TAB10[i]), fillOpacity: 0.33, stroke: DARK_STROKE, strokeOpacity: 0.85, strokeWidth: 0, pointRadius: 12.5, opacity: 1 });
/** The sketch keeps its own style: only its color comes from the cycle. */
const SKETCH = (i: number) => ({ fill: constant(TAB10[i]), fillOpacity: 0.45, stroke: TAB10[i], strokeOpacity: 0.95, strokeWidth: 2, pointRadius: 4, opacity: 1 });
/** A style a caller gives: kept as given whatever the defaults say. */
const GIVEN = { fill: constant({ r: 18, g: 52, b: 86, a: 1 }), fillOpacity: 0.6, stroke: { r: 101, g: 67, b: 33, a: 1 },
  strokeOpacity: 0.4, strokeWidth: 1.5, pointRadius: 7, opacity: 0.9 };

const SQL = {
  points: "SELECT ST_Point(13.40, 52.52) AS geom",
  lines: "SELECT ST_GeomFromText('LINESTRING (13.30 52.45, 13.50 52.58)') AS geom",
  areas: "SELECT ST_GeomFromText('POLYGON ((13.30 52.45, 13.50 52.45, 13.50 52.58, 13.30 52.45))') AS geom",
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "layer-defaults-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  await retirementsSettled(); closeMetadataDb(); resetQueryInstance();
  vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const revision = (mapId: string) => String(readDocumentRevision({ kind: "map", id: mapId })!.editRevision);
function request(url: string, method: string, body: unknown, mapId = "", actor = "test-account") {
  return testAccountRequest(new Request(origin + url, {
    method, body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(mapId ? { "X-Edit-Revision": revision(mapId) } : {}) },
  }), metadataDb(), actor);
}
/** A creating call as the map's owner, answered 201. */
async function post(handler: Handler, url: string, body: unknown, mapId = "") {
  const response = await handler(request(url, "POST", body, mapId), { params: Promise.resolve({ id: mapId }) });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return response.json();
}
/** An admin changes the defaults through the change operation. */
async function changeDefaults(patch: Record<string, unknown>) {
  testAccountScope(metadataDb(), "admin");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const response = await changeInstanceSettings(request("/api/instance/settings", "PATCH", patch, "", "admin"));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}
const storedStyles = (mapId: string) => (metadataDb().prepare("SELECT name, style FROM layers WHERE map_id = ? ORDER BY ordinal")
  .all(mapId) as { name: string; style: string }[]).map(layer => [layer.name, JSON.parse(layer.style)]);

it("gives new layers the cycle's colors in order with their geometry's opacity, the line width and the point radius; a given style is kept; a sketch takes only the color", async () => {
  const map = await post(createMap, "/api/maps", { name: "Defaults" });
  await changeDefaults(LAYER_DEFAULTS);
  for (const [name, sql] of [["Points", SQL.points], ["Lines", SQL.lines], ["Areas", SQL.areas]]) {
    await post(createLayer, `/api/maps/${map.id}/layers`, { name, sql }, map.id);
  }
  // An agent's layer, through the generated tool: the next color, the point defaults.
  const tool = buildTools().find(candidate => candidate.name === "create_layer")!;
  const agent = await executeTool(tool, declaredRevisionArguments(tool, { id: map.id, name: "Agent points", sql: SQL.points },
    readDocumentRevision({ kind: "map", id: map.id })!), origin,
  (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch);
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  await post(createLayer, `/api/maps/${map.id}/layers`, { name: "Given", sql: SQL.areas, style: GIVEN }, map.id);
  await post(createSketch, `/api/maps/${map.id}/sketches`, { feature: { kind: "point", geometry: { type: "Point", coordinates: [13.45, 52.5] } } }, map.id);

  expect(storedStyles(String(map.id))).toEqual([
    ["Points", POINTS(0)], ["Lines", LINES(1)], ["Areas", AREAS(2)], ["Agent points", POINTS(3)], ["Given", GIVEN], ["Sketch", SKETCH(5)],
  ]);
}, 60_000);

it("keeps a given style the same whatever the defaults say", async () => {
  const map = await post(createMap, "/api/maps", { name: "Given" });
  await post(createLayer, `/api/maps/${map.id}/layers`, { name: "Before", sql: SQL.lines, style: GIVEN }, map.id);
  await changeDefaults(LAYER_DEFAULTS);
  await post(createLayer, `/api/maps/${map.id}/layers`, { name: "After", sql: SQL.lines, style: GIVEN }, map.id);
  expect(storedStyles(String(map.id))).toEqual([["Before", GIVEN], ["After", GIVEN]]);
}, 60_000);
