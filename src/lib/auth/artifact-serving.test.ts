import { publishPictureFixture, preparePictureFixture } from "@/lib/test-support/picture-fixture";
import { readThumbnail, saveThemedThumbnail } from "@/lib/map-thumbnails";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { listLayers, type Layer, type MapRecord } from "@/lib/metadata/maps";
import type { DataTable } from "@/lib/metadata/tables";
import { copyThumbnail, thumbnailPath } from "@/lib/map-thumbnails";
import { publishMap, getPublishedView, resetPublishCache } from "@/lib/publish/publish-service";
import { currentPublishedTile } from "@/lib/tiles/published";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { fileDataset, shareProject, unfileDataset } from "@/lib/test-support/sharing";
import type { AccountScope } from "./scope";

/**
 * Retained artifacts are served by what they drew, warmed by the owner.
 *
 * Ada owns `roads`, filed in her project P, and `parks`, filed nowhere. Bob is
 * a viewer of P and Cyd an editor; Zed belongs to nothing. Ada's map M in P
 * draws `roads`. Ada renders it over the render cap and captures its card
 * image, then the others read: whoever reaches the map and every dataset an
 * artifact drew is served it; otherwise a tile request fails by name and an
 * image read answers the placeholder, and an unattributed artifact is the
 * map owner's alone. Each case changes one thing (withdrawal, SQL
 * replacement, transfer, a catalogue read, a late upload) and asks again.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
let layer: Layer;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "artifact-serving-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.stubEnv("DEZFIL_RENDER_CAP_FEATURES", "1");
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds(); resetPublishCache();
  scopes = Object.fromEntries(["ada", "bob", "cyd", "zed"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const name of ["roads", "parks"]) {
    const file = path.join(directory, `${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${name} a,1,2\n${name} b,3,4\n${name} c,5,6\n`);
    tables[name] = await ingestFile(scopes.ada, file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "viewer"], ["cyd", "editor"]], [tables.roads.id]);
  map = createMap(scopes.ada, "Survey", "P");
  layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
});
afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds(); resetPublishCache(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>,
  method = "GET", body?: Uint8Array<ArrayBuffer>) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method,
    ...(body ? { body, headers: { "content-type": "image/png" } } : {}) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, bytes, body: type.includes("json") ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null };
}
const route = {
  render: () => import("@/app/api/layers/[id]/render/route"),
  tile: () => import("@/app/api/layers/[id]/tiles/[z]/[x]/[y]/route"),
  thumbnail: () => import("@/app/api/maps/[id]/thumbnail/route"),
};
const render = async (account: string, target: Layer = layer) =>
  (await call(account, route.render, `/api/layers/${target.id}/render`, { id: target.id })).body as {
    ok: boolean; mode?: string; tiles?: { state: string }; error?: { code: string; message: string };
  };
const tile = (account: string, target: Layer = layer) =>
  call(account, route.tile, `/api/layers/${target.id}/tiles/0/0/0`, { id: target.id, z: "0", x: "0", y: "0" });
const image = (account: string, target: MapRecord = map) =>
  call(account, route.thumbnail, `/api/maps/${target.id}/thumbnail`, { id: target.id });
const png = (tag: string) => new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]));
async function capture(tag: string, target: MapRecord = map) { await publishPictureFixture(scopes.ada, target.id, png(tag)); }
/** The owner warms the layer's archive. */
async function warm(target: Layer = layer) {
  expect((await render("ada", target)).mode).toBe("tiled");
  await tileBuildsSettled();
  expect((await render("ada", target)).tiles?.state).toBe("ready");
}
const NOT_AVAILABLE = { error: { code: "not_found", message: "These tiles are not available to you." } };
const PLACEHOLDER = { error: { code: "not_found", message: "This map has no snapshot yet." } };
function transfer(target: MapRecord, from: string, to: string) {
  const db = metadataDb();
  db.transaction(() => {
    db.prepare("INSERT INTO ownership_transfer_gate VALUES (1, 'map', ?, ?, ?)").run(target.id, from, to);
    db.prepare("UPDATE maps SET owner_id = ? WHERE id = ?").run(to, target.id);
    db.prepare("DELETE FROM ownership_transfer_gate").run();
  })();
}

describe("retained artifacts are served by what they drew", () => {
  it("serves the owner's archive and image to a member, and withdrawal refuses the member while the owner keeps them", async () => {
    await warm();
    await capture("roads");
    for (const account of ["bob", "cyd"]) {
      expect((await render(account)).tiles?.state, account).toBe("ready");
      const served = await tile(account);
      expect(served.status, account).toBe(200);
      expect(served.bytes.byteLength, account).toBeGreaterThan(0);
      expect(Buffer.from((await image(account)).bytes).toString("latin1"), account).toContain("roads");
    }
    // An outsider is refused exactly as for a layer and a map that never existed.
    expect((await tile("zed")).body).toEqual((await call("zed", route.tile, "/api/layers/never/tiles/0/0/0", { id: "never", z: "0", x: "0", y: "0" })).body);
    expect((await image("zed")).body).toEqual((await call("zed", route.thumbnail, "/api/maps/never/thumbnail", { id: "never" })).body);

    unfileDataset("P", tables.roads.id);
    const refused = await render("bob");
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain('"roads" is not available to you');
    expect((await tile("bob")).status).toBe(404);
    expect((await tile("bob")).body).toEqual(NOT_AVAILABLE);
    expect((await image("bob")).body).toEqual(PLACEHOLDER);
    // The owner is still served both.
    expect((await render("ada")).tiles?.state).toBe("ready");
    expect((await tile("ada")).status).toBe(200);
    expect((await image("ada")).status).toBe(200);
  });

  it("never serves the old artifacts for the owner's replacement SQL", async () => {
    await warm();
    await capture("roads");
    await updateLayer(scopes.ada, layer.id, { sql: "SELECT * FROM parks" }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const edited = listLayers(map.id)[0];
    // The old archive is not ready for the new SQL, for anyone.
    expect((await render("ada", edited)).tiles?.state).toBe("building");
    expect((await render("bob", edited)).error?.message).toContain('"parks" is not available to you');
    await tileBuildsSettled();
    expect((await render("ada", edited)).tiles?.state).toBe("ready");
    expect((await tile("bob", edited)).body).toEqual(NOT_AVAILABLE);
    expect((await tile("ada", edited)).status).toBe(200);
    // The owner's next capture draws `parks`: the member gets the placeholder.
    await capture("parks");
    expect((await image("bob")).body).toEqual(PLACEHOLDER);
    expect((await image("ada")).status).toBe(200);
  });

  it("lets the new owner's reach govern after a transfer, unattributed artifacts included", async () => {
    const parks = await createLayer(scopes.ada, map.id, { name: "Parks", sql: "SELECT * FROM parks" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await warm(parks);
    // A card image made before images recorded what they drew.
    await mkdir(path.join(directory, "thumbnails"), { recursive: true });
    await writeFile(thumbnailPath(map.id), png("legacy"));
    expect((await image("ada")).status).toBe(200);
    expect((await image("cyd")).body).toEqual(PLACEHOLDER);

    transfer(map, "ada", "cyd");
    // The unattributed image is the current owner's alone.
    expect((await image("cyd")).status).toBe(200);
    expect((await image("ada")).body).toEqual(PLACEHOLDER);
    // Ada's private `parks` is beyond the new owner: its archive is not hers
    // to be served, while Ada, who reaches it as the project's owner, is.
    expect((await tile("cyd", parks)).body).toEqual(NOT_AVAILABLE);
    expect((await tile("ada", parks)).status).toBe(200);
  });

  it("serves a catalogue read's artifacts only to callers whose reach covers its whole recorded reach", async () => {
    const listing = createMap(scopes.ada, "Listing", "P");
    const read = await createLayer(scopes.ada, listing.id, {
      name: "Listing", sql: "SELECT r.* FROM roads r WHERE EXISTS (SELECT view_name FROM duckdb_views())",
    }, { expectedRevision: readEditRevision({ kind: "map", id: listing.id })?.editRevision });
    await warm(read);
    await capture("listing", listing);
    // Bob reaches `roads` but not Ada's `parks`, which the catalogue read
    // could see: neither artifact is his.
    expect((await tile("bob", read)).body).toEqual(NOT_AVAILABLE);
    expect((await image("bob", listing)).body).toEqual(PLACEHOLDER);
    // Once he reaches the whole recorded reach, both are.
    fileDataset("P", tables.parks.id);
    expect((await tile("bob", read)).status).toBe(200);
    expect((await image("bob", listing)).status).toBe(200);
    // The link withholds the catalogue: Ada's archive drew more than the map names.
    const { token } = publishMap(scopes.ada, listing.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: listing.id })?.editRevision });
    await getPublishedView(token, Date.now());
    expect(currentPublishedTile(token, read.id, null)).toBeNull();
  });

  it("rejects a late picture after SQL changes and retains the previous attributed image", async () => {
    await capture("current");
    const attempt = await preparePictureFixture(scopes.ada, map.id);
    await updateLayer(scopes.ada, layer.id, { sql: "SELECT * FROM roads WHERE sentinel <> 'none'" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await expect(attempt.publish(png("late"))).rejects.toThrow();
    expect((await image("bob")).status).toBe(200);
    expect(Buffer.from((await image("ada")).bytes).toString("latin1")).toContain("current");
  });

  it("says in the maps listing whether the image read serves the caller one", async () => {
    const listed = async (account: string, target: MapRecord) =>
      ((await call(account, () => import("@/app/api/maps/route"), "/api/maps", {})).body as { id: string; hasThumbnail: unknown }[])
        .find((m) => m.id === target.id)?.hasThumbnail;
    const agree = async (expected: Record<string, boolean>, target: MapRecord = map) => {
      for (const [account, served] of Object.entries(expected)) {
        expect((await image(account, target)).status, `${account}'s image read`).toBe(served ? 200 : 404);
        expect(await listed(account, target), `${account}'s listing`).toBe(served);
      }
    };
    // Never captured: nobody is served an image, and the listing says so.
    await agree({ ada: false, bob: false, cyd: false });
    await capture("roads");
    await agree({ ada: true, bob: true, cyd: true });
    // Withdrawn from the project: the members' read answers the placeholder.
    unfileDataset("P", tables.roads.id);
    await agree({ ada: true, bob: false, cyd: false });
    // A card image made before images recorded what they drew is the
    // owner's alone.
    const older = createMap(scopes.ada, "Older", "P");
    await writeFile(thumbnailPath(older.id), png("legacy"));
    await agree({ ada: true, bob: false, cyd: false }, older);
    // A themed pair counts once it is published, never while one theme is held.
    const themed = createMap(scopes.ada, "Themed", "P");
    const inputs = { catalogue: false, datasets: [] };
    expect(await saveThemedThumbnail(scopes.ada, themed.id, "light", "c1", png("light"), inputs)).toBe("held");
    await agree({ ada: false, bob: false }, themed);
    expect(await saveThemedThumbnail(scopes.ada, themed.id, "dark", "c1", png("dark"), inputs)).toBe("published");
    await agree({ ada: true, bob: true }, themed);
  });

  it("copies an image into someone's own map only while they may be served it", async () => {
    const bobs = createMap(scopes.bob, "Bob's own");
    await capture("roads");
    await copyThumbnail(scopes.bob, map.id, bobs.id);
    expect(Buffer.from((await readThumbnail(scopes.bob, bobs.id))!).toString("latin1")).toContain("roads");

    const later = createMap(scopes.bob, "Bob's later");
    unfileDataset("P", tables.roads.id);
    await copyThumbnail(scopes.bob, map.id, later.id);
    expect((await readdir(path.join(directory, "thumbnails"))).some((name) => name.startsWith(later.id))).toBe(false);
    // An unattributed image copies for its owner alone.
    const legacySource = createMap(scopes.ada, "Legacy source");
    await writeFile(thumbnailPath(legacySource.id), png("legacy"));
    const adas = createMap(scopes.ada, "Ada's copy");
    await copyThumbnail(scopes.ada, legacySource.id, adas.id);
    expect(Buffer.from(await readFile(thumbnailPath(adas.id))).toString("latin1")).toContain("legacy");
  });
});
