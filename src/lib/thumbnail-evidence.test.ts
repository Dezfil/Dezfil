import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { documentFacts } from "@/lib/metadata/document-facts";
import { readThumbnail, saveThumbnail } from "./map-thumbnails";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import type { Layer, MapRecord } from "@/lib/metadata/maps";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "@/lib/auth/scope";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { preparePictureFixture, publishPictureFixture } from "@/lib/test-support/picture-fixture";
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
let theirs: Layer;
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "thumbnail-evidence-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const owner of ["ada", "bob"]) {
    const file = path.join(directory, `${owner}-roads.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner},1,2\n`);
    tables[owner] = await ingestFile(scopes[owner], file, "roads.csv");
  }
  shareProject("bob", "P", [["ada", "viewer"]], [tables.bob.id]);
  map = createMap(scopes.ada, "Survey");
  await createLayer(scopes.ada, map.id, { name: "Mine", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  theirs = await createLayer(scopes.ada, map.id, { name: "Theirs", sql: "SELECT * FROM bob.roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });


async function evidence(theme: "light" | "dark" = "light") {
  const set = JSON.parse(await readFile(path.join(directory, "thumbnails", `${map.id}.json`), "utf8"));
  return JSON.parse(await readFile(path.join(directory, "artifact-inputs", "thumbnails", `${set[theme]}.json`), "utf8")) as { sha256: string; generation: number; inputs: { catalogue: boolean; datasets: { id: string }[] } };
}
const ids = (inputs: { datasets: { id: string }[] }) => inputs.datasets.map(input => input.id).sort();
it("binds both images to their own bytes, the same generation and actual evaluated inputs", async () => {
  const fixture = await publishPictureFixture(scopes.ada, map.id, png("light"), png("dark"));
  for (const theme of ["light", "dark"] as const) {
    const stamped = await evidence(theme);
    expect(stamped.sha256).toBe(createHash("sha256").update(png(theme)).digest("hex"));
    expect(stamped.generation).toBe(fixture.state.requestedGeneration);
    expect(stamped.inputs.catalogue).toBe(false);
    expect(ids(stamped.inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
  }
});
it.each(["sql", "style"])("refuses a late %s generation instead of publishing unattributed pixels", async kind => {
  await publishPictureFixture(scopes.ada, map.id, png("previous"));
  const attempt = await preparePictureFixture(scopes.ada, map.id);
  await updateLayer(scopes.ada, theirs.id, kind === "sql" ? { sql: "SELECT * FROM roads" } : { style: { ...theirs.style, opacity: .3 } }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  await expect(attempt.publish(png("late"))).rejects.toThrow();
  expect(await readThumbnail(scopes.ada, map.id)).toEqual(png("previous"));
});
it("records the whole mounted reach behind a catalogue evaluation", async () => {
  await updateLayer(scopes.ada, theirs.id, { sql: "SELECT r.* FROM roads r WHERE EXISTS (SELECT view_name FROM duckdb_views())" }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  await publishPictureFixture(scopes.ada, map.id, png("catalogue"));
  const stamped = await evidence(); expect(stamped.inputs.catalogue).toBe(true);
  expect(ids(stamped.inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
});
it("retires a replaced set's evidence when one fixed-ground image replaces the pair", async () => {
  await publishPictureFixture(scopes.ada, map.id, png("light"), png("dark"));
  const previous = await readdir(path.join(directory, "artifact-inputs", "thumbnails"));
  updateMap(scopes.ada, map.id, { basemap: "light" }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  await publishPictureFixture(scopes.ada, map.id, png("single"));
  const left = await readdir(path.join(directory, "artifact-inputs", "thumbnails"));
  expect(left).toHaveLength(1); expect(left.some(name => previous.includes(name))).toBe(false);
  expect(await readThumbnail(scopes.ada, map.id, "dark")).toEqual(png("single"));
});
it("publication leaves revision, attribution and history untouched", async () => {
  const before = documentFacts({ kind: "map", id: map.id });
  const history = metadataDb().prepare("SELECT * FROM map_history WHERE map_id = ? ORDER BY seq").all(map.id);
  await publishPictureFixture(scopes.ada, map.id, png("fresh"));
  expect(documentFacts({ kind: "map", id: map.id })).toEqual(before);
  expect(metadataDb().prepare("SELECT * FROM map_history WHERE map_id = ? ORDER BY seq").all(map.id)).toEqual(history);
});
it("legacy unattributed bytes remain the owner's alone", async () => {
  shareProject("ada", "Map readers", [["bob", "viewer"]]);
  metadataDb().prepare("UPDATE maps SET project_id = ? WHERE id = ?").run("Map readers", map.id);
  await saveThumbnail(scopes.ada, map.id, png("legacy"));
  expect(await readThumbnail(scopes.ada, map.id)).toEqual(png("legacy"));
  expect(await readThumbnail(scopes.bob, map.id)).toBeNull();
});
