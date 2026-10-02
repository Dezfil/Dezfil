import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "../metadata/db";
import { resetQueryInstance } from "../duckdb";
import { testAccountRequest, testAccountScope } from "../test-support/accounts";
import { createMap, readMap, updateMap } from "../map-service";
import { publishMap } from "../publish/publication-state";
import * as ingest from "../ingest/ingest";
import { retirementsSettled } from "../ingest/retire";
import { appendFeature, cascadeDeleteSketch, createSketch } from "./store";
import { POST } from "@/app/api/maps/[id]/sketches/route";
import { DELETE } from "@/app/api/layers/[id]/route";
import { buildTools } from "../tools/tools";

const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "sketch-basis-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  vi.restoreAllMocks(); await retirementsSettled(); closeMetadataDb(); resetQueryInstance();
  vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});
const feature = { kind: "point", geometry: { type: "Point", coordinates: [13, 52] } };
const stale = { status: 409, code: "stale_revision", message: "This item has changed. Reload it before trying again." };
const missing = { status: 400, code: "invalid_request", message: "Read this item first, then send its editRevision in X-Edit-Revision." };
const rows = () => ["maps", "layers", "map_history", "data_tables", "project_datasets"]
  .map(table => metadataDb().prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
async function artifacts() {
  const files: Record<string, string> = {};
  for (const folder of ["tables", "tiles"]) {
    const base = path.join(directory, folder);
    const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(directory, file)] = (await readFile(file)).toString("base64");
    }
  }
  return files;
}
async function fixture() {
  const scope = testAccountScope(), map = createMap(scope, "Sketches");
  const attached = await createSketch(scope, map.id, feature, { expectedRevision: map.editRevision });
  await mkdir(path.join(directory, "tiles"), { recursive: true });
  await writeFile(path.join(directory, "tiles", `${attached.layerId}.pmtiles`), "existing tile bytes");
  publishMap(scope, map.id);
  return { scope, map: readMap(scope, map.id), attached };
}
for (const basis of [undefined, "bad", "stale"] as const) it(`refuses ${basis ?? "missing"} sketch attachment and removal without changing rows or artifacts`, async () => {
  const { scope, map, attached } = await fixture();
  updateMap(scope, map.id, { name: "Another edit" }, { expectedRevision: map.editRevision });
  const expectedRevision = basis === "stale" ? map.editRevision : basis;
  const before = rows(), bytes = await artifacts(), expected = basis === "stale" ? stale : missing;
  await expect(createSketch(scope, map.id, feature, { expectedRevision })).rejects.toMatchObject(expected);
  expect(rows()).toEqual(before); expect(await artifacts()).toEqual(bytes);
  await expect(cascadeDeleteSketch(scope, attached.table.name, "layer", { expectedRevision })).rejects.toMatchObject(expected);
  expect(rows()).toEqual(before); expect(await artifacts()).toEqual(bytes);
});
it("removes the staged artifact when another edit wins during sketch measurement", async () => {
  const { scope, map } = await fixture(), bytes = await artifacts();
  const measure = ingest.measureArtifact;
  let accepted: unknown;
  vi.spyOn(ingest, "measureArtifact").mockImplementationOnce(async (...args) => {
    const result = await measure(...args);
    updateMap(scope, map.id, { name: "Won during measurement" }, { expectedRevision: map.editRevision });
    accepted = rows(); return result;
  });
  await expect(createSketch(scope, map.id, feature, { expectedRevision: map.editRevision })).rejects.toMatchObject(stale);
  expect(rows()).toEqual(accepted); expect(await artifacts()).toEqual(bytes);
});
it("stale sketch removal keeps the dataset, publication, cursor and artifact bytes intact", async () => {
  const { scope, map, attached } = await fixture();
  updateMap(scope, map.id, { name: "New name" }, { expectedRevision: map.editRevision });
  const before = rows(), bytes = await artifacts();
  await expect(cascadeDeleteSketch(scope, attached.table.name, "layer", { expectedRevision: map.editRevision })).rejects.toMatchObject(stale);
  expect(rows()).toEqual(before); expect(await artifacts()).toEqual(bytes);
});
it("accepts only one attachment against a revision and leaves only its artifact", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Two drawers");
  const outcomes = await Promise.allSettled([1, 2].map(() => createSketch(scope, map.id, feature, { expectedRevision: map.editRevision })));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: stale });
  expect(readMap(scope, map.id).layers).toHaveLength(1);
  expect(metadataDb().prepare("SELECT id FROM data_tables").all()).toHaveLength(1);
  expect(Object.keys(await artifacts())).toHaveLength(1);
});
it("carries route preconditions and keeps dataset feature changes and deletion exempt", async () => {
  const { scope, map, attached } = await fixture();
  const request = (method: string, basis?: string) => testAccountRequest(new Request("http://instance.test/api/sketch", {
    method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": basis } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ feature }) } : {}),
  }));
  for (const c of [{ handler: POST, method: "POST", id: map.id }, { handler: DELETE, method: "DELETE", id: attached.layerId }]) {
    const req = request(c.method), before = rows(), bytes = await artifacts();
    const refused = await c.handler(req, { params: Promise.resolve({ id: c.id }) });
    expect(refused.status).toBe(400); expect(await refused.json()).toEqual({ error: { code: missing.code, message: missing.message } });
    expect(rows()).toEqual(before); expect(await artifacts()).toEqual(bytes);
  }
  expect(buildTools().find(tool => tool.name === "create_sketch")!.inputSchema.required).toContain("expected_revision");
  expect(buildTools().find(tool => tool.name === "delete_sketch")!.inputSchema.properties).not.toHaveProperty("expected_revision");
  await appendFeature(scope, attached.table.name, feature);
  expect(readMap(scope, map.id).editRevision).toBe(map.editRevision);
  const deleted = await cascadeDeleteSketch(scope, attached.table.name);
  expect(deleted.editRevision).not.toBe(map.editRevision);
  expect(readMap(scope, map.id).layers).toHaveLength(0);
});
