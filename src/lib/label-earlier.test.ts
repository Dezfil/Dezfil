import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { recordStep } from "@/lib/metadata/history";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";

/**
 * Labels stored before a label carried its text and halo choices, read
 * wherever a stored map is read: a map's and a layer's reads, and the undo
 * and redo that put back images recorded before the change. Each follows
 * the map only with the whole old starting paint, the old boolean halo
 * read first; every other one keeps its own paint, and its size, weight
 * and every other setting. Reading changes nothing stored, and a new write
 * of the old starting paint without choices stays the label's own.
 */

let dir: string;
beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-earlier-`);
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
// Written out here, not read from the code under test.
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const OLD_HALO = { r: 12, g: 16, b: 24, a: 0.8 };
const INK = { r: 20, g: 30, b: 40, a: 1 };

/** Each earlier label as it was stored, and the choice it reads as. The
 * boolean halos carry no width or colour, as they were stored. */
const FIXTURES: [string, Record<string, unknown>, "automatic" | "own"][] = [
  ["the complete old starting paint", { color: WHITE, haloWidth: 0, haloColor: OLD_HALO }, "automatic"],
  ["white with a visible halo", { color: WHITE, haloWidth: 1, haloColor: OLD_HALO }, "own"],
  ["text in another colour", { color: INK, haloWidth: 0, haloColor: OLD_HALO }, "own"],
  ["white that is not opaque", { color: { ...WHITE, a: 0.6 }, haloWidth: 0, haloColor: OLD_HALO }, "own"],
  ["a width-0 halo in another colour", { color: WHITE, haloWidth: 0, haloColor: INK }, "own"],
  ["the old boolean halo, off", { color: WHITE, halo: false }, "automatic"],
  ["the old boolean halo, on", { color: WHITE, halo: true }, "own"],
];

/** What the label is once read: the old boolean as width and colour. */
function migrated(label: Record<string, unknown>) {
  if (typeof label.halo !== "boolean") return label;
  const { halo, ...rest } = label;
  return { ...rest, haloWidth: halo ? 1 : 0, haloColor: OLD_HALO };
}

const storedLabel = (label: Record<string, unknown>, size = 12) =>
  ({ ...defaultStyle("POINT"), label: { attribute: "name", size, weight: "bold", density: 0.25, ...label } });

async function http(method: string, url: string, revision?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (revision) headers["X-Edit-Revision"] = revision;
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  expect(response.status, url).toBeLessThan(300);
  return response.json();
}

const revision = (mapId: string) => readDocumentRevision({ kind: "map", id: mapId })!.editRevision!;
const row = (layerId: string) =>
  (metadataDb().prepare("SELECT style FROM layers WHERE id = ?").get(layerId) as { style: string }).style;
const steps = (mapId: string) =>
  (metadataDb().prepare("SELECT COUNT(*) AS n FROM map_history WHERE map_id = ?").get(mapId) as { n: number }).n;

/** A map with one layer whose stored row holds the label as given, written
 * straight to the store as an earlier release left it. */
async function storedMap(label: Record<string, unknown>, size = 12) {
  const scope = testAccountScope();
  const map = createMap(scope, "Earlier");
  const layer = await createLayer(scope, map.id, { name: "Places", sql: SQL }, { expectedRevision: revision(map.id) });
  metadataDb().prepare("UPDATE layers SET style = ? WHERE id = ?").run(JSON.stringify(storedLabel(label, size)), layer.id);
  return { map, layer };
}

/** The label as both reads answer it, which must agree. */
async function readLabel(mapId: string, layerId: string) {
  const fromLayer = (await http("GET", `/api/layers/${layerId}`)).style.label;
  const fromMap = (await http("GET", `/api/maps/${mapId}`)).layers.find((l: { id: string }) => l.id === layerId).style.label;
  expect(fromMap).toEqual(fromLayer);
  return fromLayer;
}

/** The parts of a label that are not its paint, which every reading keeps. */
const settings = (label: Record<string, unknown>) => {
  const { attribute, size, weight, density } = label;
  return { attribute, size, weight, density };
};

describe.each(FIXTURES)("an earlier label: %s", (_name, label, choice) => {
  it("reads as the rule says from a stored map, keeping every other setting", async () => {
    const { map, layer } = await storedMap(label);
    const read = await readLabel(map.id, layer.id);
    expect([read.textPaint, read.haloPaint]).toEqual([choice, choice]);
    expect(settings(read)).toEqual({ attribute: "name", size: 12, weight: "bold", density: 0.25 });
    // A label of its own keeps its colours exactly, the old boolean read as width and colour.
    const { color, haloWidth, haloColor } = migrated(label);
    if (choice === "own") expect({ color: read.color, haloWidth: read.haloWidth, haloColor: read.haloColor }).toEqual({ color, haloWidth, haloColor });
  });

  it("changes nothing stored when read, however often", async () => {
    const { map, layer } = await storedMap(label);
    const before = { row: row(layer.id), revision: revision(map.id), steps: steps(map.id) };
    const first = await readLabel(map.id, layer.id);
    const second = await readLabel(map.id, layer.id);
    expect(second).toEqual(first);
    expect({ row: row(layer.id), revision: revision(map.id), steps: steps(map.id) }).toEqual(before);
  });

  it("reads as the rule says when undo and redo put back images recorded before the change", async () => {
    const { map, layer } = await storedMap(label, 14);
    // The step an earlier release recorded: the label resized, both images in the old shape.
    recordStep({
      mapId: map.id, scope: "layer", targetId: layer.id, op: "update",
      before: { style: storedLabel(label, 12) }, after: { style: storedLabel(label, 14) },
    }, metadataDb(), testAccountScope());
    const undone = await http("POST", `/api/maps/${map.id}/undo`, revision(map.id));
    const undoneLabel = undone.layers.find((l: { id: string }) => l.id === layer.id).style.label;
    expect([undoneLabel.textPaint, undoneLabel.haloPaint, undoneLabel.size]).toEqual([choice, choice, 12]);
    expect(await readLabel(map.id, layer.id)).toEqual(undoneLabel);
    const redone = await http("POST", `/api/maps/${map.id}/redo`, revision(map.id));
    const redoneLabel = redone.layers.find((l: { id: string }) => l.id === layer.id).style.label;
    expect([redoneLabel.textPaint, redoneLabel.haloPaint, redoneLabel.size]).toEqual([choice, choice, 14]);
    expect(await readLabel(map.id, layer.id)).toEqual(redoneLabel);
  });
});

describe("a new write of the old starting paint without choices", () => {
  it("stays the label's own after a reread, and after undo and redo", async () => {
    const scope = testAccountScope();
    const map = createMap(scope, "Written");
    const layer = await createLayer(scope, map.id, { name: "Places", sql: SQL }, { expectedRevision: revision(map.id) });
    const old = { color: WHITE, haloWidth: 0, haloColor: OLD_HALO };
    const written = await http("PATCH", `/api/layers/${layer.id}`, revision(map.id), { style: storedLabel(old) });
    const own = { ...storedLabel(old).label, textPaint: "own", haloPaint: "own" };
    expect(written.style.label).toEqual(own);
    expect(await readLabel(map.id, layer.id)).toEqual(own);
    // The write is the step undo takes back; redo puts back what it stored.
    const undone = await http("POST", `/api/maps/${map.id}/undo`, revision(map.id));
    expect(undone.layers[0].style.label).toBeUndefined();
    const redone = await http("POST", `/api/maps/${map.id}/redo`, revision(map.id));
    expect(redone.layers[0].style.label).toEqual(own);
    expect(await readLabel(map.id, layer.id)).toEqual(own);
    expect(JSON.parse(row(layer.id)).label).toMatchObject({ textPaint: "own", haloPaint: "own" });
  });
});
