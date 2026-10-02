import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentFacts } from "@/lib/metadata/document-facts";
import { readThumbnail } from "./map-thumbnails";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { listLayers, type Layer, type MapRecord } from "@/lib/metadata/maps";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "@/lib/auth/scope";
import { mapSqlRevision } from "@/lib/map-sql-revision";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";

/**
 * A card image is stamped with what its map's SQL draws at the revision the
 * builder saw when the capture started. Ada and Bob each own a `roads`; Bob
 * files his in project P, where Ada is a viewer. Ada's map draws her `roads`
 * and Bob's `bob.roads`. An upload with the map's current revision is stamped
 * with both identities; one with no revision, or a revision the layers have
 * moved from (a late upload after a SQL change), is kept unattributed, each
 * image of a themed pair on its own.
 */
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

async function upload(body: Buffer, query: string, editRevision?: string) {
  const { PUT } = await import("@/app/api/maps/[id]/thumbnail/route");
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${map.id}/thumbnail?${query}`, {
    method: "PUT", headers: { "content-type": "image/png", ...(editRevision ? { "X-Edit-Revision": editRevision } : {}) }, body: new Uint8Array(body),
  }), undefined, "ada");
  return PUT(request, { params: Promise.resolve({ id: map.id }) });
}
const revision = () => mapSqlRevision(listLayers(map.id));
/** The evidence on the volume for one image file, exactly as written. */
async function evidence(image: string) {
  const file = path.join(directory, "artifact-inputs", "thumbnails", `${image}.json`);
  return JSON.parse(await readFile(file, "utf8")) as { sha256: string; inputs: { catalogue: boolean; datasets: { id: string }[] } | null };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ids = (inputs: { datasets: { id: string }[] } | null) => inputs?.datasets.map((input) => input.id).sort() ?? null;

describe("card images record what they drew", () => {
  it("stamps an upload at the map's current revision with the identities its SQL binds", async () => {
    const body = png("current");
    expect((await upload(body, `revision=${revision()}`)).status).toBe(204);
    const stamped = await evidence(`${map.id}.png`);
    expect(stamped.sha256).toBe(sha(body));
    expect(stamped.inputs?.catalogue).toBe(false);
    expect(ids(stamped.inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
  });

  it("keeps an upload with no revision unattributed", async () => {
    expect((await upload(png("bare"), "")).status).toBe(204);
    expect((await evidence(`${map.id}.png`)).inputs).toBeNull();
  });

  it("keeps a late upload after a SQL change unattributed", async () => {
    const seen = revision();
    await updateLayer(scopes.ada, theirs.id, { sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(theirs.id)?.mapId ?? "missing") })?.editRevision });
    expect((await upload(png("late"), `revision=${seen}`)).status).toBe(204);
    expect((await evidence(`${map.id}.png`)).inputs).toBeNull();
  });

  it("stamps each image of a themed pair on its own", async () => {
    const seen = revision();
    expect((await upload(png("light"), `theme=light&cycle=c1&revision=${seen}`)).status).toBe(202);
    await updateLayer(scopes.ada, theirs.id, { sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(theirs.id)?.mapId ?? "missing") })?.editRevision });
    expect((await upload(png("dark"), `theme=dark&cycle=c1&revision=${seen}`)).status).toBe(204);
    expect(ids((await evidence(`${map.id}.c1.light.png`)).inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
    expect((await evidence(`${map.id}.c1.dark.png`)).inputs).toBeNull();
  });

  it("records the whole reach behind a catalogue read", async () => {
    await updateLayer(scopes.ada, theirs.id, { sql: "SELECT r.* FROM roads r WHERE EXISTS (SELECT view_name FROM duckdb_views())" }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(theirs.id)?.mapId ?? "missing") })?.editRevision });
    expect((await upload(png("listing"), `revision=${revision()}`)).status).toBe(204);
    const stamped = await evidence(`${map.id}.png`);
    expect(stamped.inputs?.catalogue).toBe(true);
    expect(ids(stamped.inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
  });

  it("refuses a malformed revision before storing anything", async () => {
    const response = await upload(png("x"), "revision=not-a-revision");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(await readdir(path.join(directory, "thumbnails")).catch(() => [])).toEqual([]);
  });

  it("retires an image's evidence with the image", async () => {
    await upload(png("light"), `theme=light&cycle=c1&revision=${revision()}`);
    await upload(png("dark"), `theme=dark&cycle=c1&revision=${revision()}`);
    await upload(png("single"), `revision=${revision()}`);
    const left = await readdir(path.join(directory, "artifact-inputs", "thumbnails"));
    expect(left).toEqual([`${map.id}.png.json`]);
  });
});


it.each([undefined, "obsolete-edit-revision"])("lands captures through style changes without moving document attribution (%s)", async editRevision => {
  const seen = revision();
  await updateLayer(scopes.ada, theirs.id, { style: { ...theirs.style, opacity: 0.5 } }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  const afterStyle = documentFacts({ kind: "map", id: map.id });
  expect((await upload(png("light"), `theme=light&cycle=style&revision=${seen}`, editRevision)).status).toBe(202);
  expect(documentFacts({ kind: "map", id: map.id })).toEqual(afterStyle);
  await updateLayer(scopes.ada, theirs.id, { style: { ...theirs.style, opacity: 0.3 } }, { expectedRevision: afterStyle.editRevision });
  const betweenImages = documentFacts({ kind: "map", id: map.id });
  expect((await upload(png("dark"), `theme=dark&cycle=style&revision=${seen}`, editRevision)).status).toBe(204);
  expect(documentFacts({ kind: "map", id: map.id })).toEqual(betweenImages);
  for (const theme of ["light", "dark"] as const) {
    expect(await readThumbnail(scopes.ada, map.id, theme)).toEqual(png(theme));
    expect(ids((await evidence(`${map.id}.style.${theme}.png`)).inputs)).toEqual([tables.ada.id, tables.bob.id].sort());
  }
});

it.each(["missing", "stale"])("lands %s SQL evidence for the owner alone", async state => {
  const seen = revision();
  shareProject("ada", "Map readers", [["bob", "viewer"]]);
  metadataDb().prepare("UPDATE maps SET project_id = ? WHERE id = ?").run("Map readers", map.id);
  if (state === "stale") await updateLayer(scopes.ada, theirs.id, { sql: "SELECT * FROM roads" }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  const before = documentFacts({ kind: "map", id: map.id });
  expect((await upload(png(state), state === "stale" ? `revision=${seen}` : "", "obsolete")).status).toBe(204);
  expect(await readThumbnail(scopes.ada, map.id)).toEqual(png(state));
  expect(await readThumbnail(scopes.bob, map.id)).toBeNull();
  expect(documentFacts({ kind: "map", id: map.id })).toEqual(before);
});
