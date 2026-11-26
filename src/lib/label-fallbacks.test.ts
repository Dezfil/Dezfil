import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import JSZip from "jszip";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { createProject } from "@/lib/metadata/owned-projects";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";

/**
 * The concrete paint every label carries out of the server beside its two
 * choices. For an automatic part it is the light-appearance recipe for
 * the map's basemap as saved when it is read, on every road a layer
 * leaves by: a layer's own read, a map's layer list and its read, the
 * create, update and duplicate answers, undo and redo, the published
 * snapshot and the project export. After a change of only the basemap,
 * and after its undo, each answers exactly the recipe for the basemap
 * saved then; the stored layer, its revision and its history never move
 * for it. A style save stores the fallbacks of its moment. An own colour
 * is kept exactly throughout.
 */

let dir: string;
beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-fallbacks-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
});
afterAll(async () => {
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry";
// The recipes, written out as the hex values they name.
const LIGHT = { color: { r: 0x24, g: 0x32, b: 0x30, a: 1 }, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 } };
const DARK = { color: { r: 0xe9, g: 0xec, b: 0xf3, a: 1 }, haloWidth: 1.5, haloColor: { r: 0x0b, g: 0x0e, b: 0x14, a: 1 } };
const OWN = { color: { r: 200, g: 40, b: 40, a: 0.8 }, haloWidth: 2, haloColor: { r: 10, g: 60, b: 90, a: 0.5 } };

async function http(method: string, url: string, body?: unknown, revision?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (revision) headers["X-Edit-Revision"] = revision;
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  expect(response.status, url).toBeLessThan(300);
  return response;
}
const json = async (method: string, url: string, body?: unknown, revision?: string) => (await http(method, url, body, revision)).json();
const revision = (mapId: string) => readDocumentRevision({ kind: "map", id: mapId })!.editRevision!;
const row = (layerId: string) =>
  (metadataDb().prepare("SELECT style FROM layers WHERE id = ?").get(layerId) as { style: string }).style;
const steps = (mapId: string) =>
  (metadataDb().prepare("SELECT COUNT(*) AS n FROM map_history WHERE map_id = ?").get(mapId) as { n: number }).n;

type Recipe = typeof LIGHT;
interface Label { textPaint: string; haloPaint: string; color: unknown; haloWidth: unknown; haloColor: unknown }
const paint = (label: Label) => ({ color: label.color, haloWidth: label.haloWidth, haloColor: label.haloColor });

/** Exact: the automatic label answers this recipe and nothing else. */
function expectRecipe(label: Label, recipe: Recipe, where: string) {
  expect([label.textPaint, label.haloPaint], where).toEqual(["automatic", "automatic"]);
  expect(paint(label), where).toEqual(recipe);
}
function expectOwn(label: Label, where: string) {
  expect([label.textPaint, label.haloPaint], where).toEqual(["own", "own"]);
  expect(paint(label), where).toEqual(OWN);
}

const labelOf = (layers: { id: string; style: { label: Label } }[], id: string) => layers.find((l) => l.id === id)!.style.label;

let project: string;
let mapId: string;
let automatic: string;
let own: string;
let token: string;

/** Every road a layer leaves the server by, each answering the recipe. */
async function everyRoad(recipe: Recipe) {
  expectRecipe((await json("GET", `/api/layers/${automatic}`)).style.label, recipe, "the layer's read");
  expectOwn((await json("GET", `/api/layers/${own}`)).style.label, "the own layer's read");
  const listed = await json("GET", `/api/maps/${mapId}/layers`);
  expectRecipe(labelOf(listed, automatic), recipe, "the map's layer list");
  const map = await json("GET", `/api/maps/${mapId}`);
  expectRecipe(labelOf(map.layers, automatic), recipe, "the map's read");
  expectOwn(labelOf(map.layers, own), "the map's read, own");
  const published = await json("GET", `/api/published/${token}`);
  expectRecipe(labelOf(published.layers, automatic), recipe, "the published snapshot");
  expectOwn(labelOf(published.layers, own), "the published snapshot, own");
  const exported = await JSZip.loadAsync(Buffer.from(await (await http("POST", `/api/projects/${project}/export`, { file: "p", maps: [mapId] })).arrayBuffer()));
  const document = JSON.parse(await exported.file("p.dezfil/maps/fallbacks.json")!.async("string"));
  expectRecipe(labelOf(document.layers, automatic), recipe, "the exported map document");
  expectOwn(labelOf(document.layers, own), "the exported map document, own");
}

beforeAll(async () => {
  const scope = testAccountScope();
  project = createProject(scope, { name: "Fallbacks" }).id;
  const map = await json("POST", "/api/maps", { name: "Fallbacks", projectId: project });
  mapId = map.id;
  await json("PATCH", `/api/maps/${mapId}`, { basemap: "light" }, revision(mapId));
  const label = { attribute: "name", size: 12 };
  automatic = (await json("POST", `/api/maps/${mapId}/layers`, { name: "Automatic", sql: SQL, style: { ...defaultStyle("POINT"), label } }, revision(mapId))).id;
  own = (await json("POST", `/api/maps/${mapId}/layers`, { name: "Own", sql: SQL, style: { ...defaultStyle("POINT"), label: { ...label, ...OWN } } }, revision(mapId))).id;
  token = (await json("POST", `/api/maps/${mapId}/publish`, {}, revision(mapId))).token;
});

describe("the fallbacks a label carries out of the server", () => {
  it("are the saved basemap's recipe on every road, and fail on any other valid colour", async () => {
    await everyRoad(LIGHT);
    // The check is exact: the other recipe, or one channel off, does not pass it.
    const read = (await json("GET", `/api/layers/${automatic}`)).style.label;
    expect(() => expectRecipe(read, DARK, "control")).toThrow();
    expect(() => expectRecipe(read, { ...LIGHT, color: { ...LIGHT.color, r: LIGHT.color.r + 1 } }, "control")).toThrow();
  });

  it("follow a change of only the basemap, and its undo, without moving the stored layer", async () => {
    const stored = { automatic: row(automatic), own: row(own) };
    const changed = await json("PATCH", `/api/maps/${mapId}`, { basemap: "dark" }, revision(mapId));
    expectRecipe(labelOf(changed.layers, automatic), DARK, "the map update's answer");
    const before = { revision: revision(mapId), steps: steps(mapId) };
    await everyRoad(DARK);
    // Reading moved nothing: the rows, the revision and the history.
    expect({ automatic: row(automatic), own: row(own) }).toEqual(stored);
    expect({ revision: revision(mapId), steps: steps(mapId) }).toEqual(before);

    const undone = await json("POST", `/api/maps/${mapId}/undo`, undefined, revision(mapId));
    expectRecipe(labelOf(undone.layers, automatic), LIGHT, "the undo's answer");
    await everyRoad(LIGHT);
    const redone = await json("POST", `/api/maps/${mapId}/redo`, undefined, revision(mapId));
    expectRecipe(labelOf(redone.layers, automatic), DARK, "the redo's answer");
    await everyRoad(DARK);
    expect({ automatic: row(automatic), own: row(own) }).toEqual(stored);
  });

  it("answer the create, update and duplicate for the basemap saved then, and a style save stores them", async () => {
    await json("PATCH", `/api/maps/${mapId}`, { basemap: "satellite" }, revision(mapId));
    const style = { ...defaultStyle("POINT"), label: { attribute: "name", size: 12 } };
    const created = await json("POST", `/api/maps/${mapId}/layers`, { name: "Created", sql: SQL, style }, revision(mapId));
    expectRecipe(created.style.label, DARK, "the create's answer");
    const duplicated = await json("POST", `/api/layers/${automatic}/duplicate`, undefined, revision(mapId));
    expectRecipe(duplicated.style.label, DARK, "the duplicate's answer");
    await json("PATCH", `/api/maps/${mapId}`, { basemap: "streets" }, revision(mapId));
    expectRecipe((await json("GET", `/api/layers/${duplicated.id}`)).style.label, LIGHT, "the duplicate's read on Streets");
    const read = (await json("GET", `/api/layers/${automatic}`)).style;
    const updated = await json("PATCH", `/api/layers/${automatic}`, { style: { ...read, label: { ...read.label, size: 13 } } }, revision(mapId));
    expectRecipe(updated.style.label, LIGHT, "the update's answer");
    // The save stored the fallbacks of its moment; a later basemap moves only the answers.
    expect(paint(JSON.parse(row(automatic)).label)).toEqual(LIGHT);
    await json("PATCH", `/api/maps/${mapId}`, { basemap: "dark" }, revision(mapId));
    expect(paint(JSON.parse(row(automatic)).label)).toEqual(LIGHT);
    expectRecipe((await json("GET", `/api/layers/${automatic}`)).style.label, DARK, "the read after the save");
  });
});
