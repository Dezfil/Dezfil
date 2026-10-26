import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer } from "@/lib/layer-service";
import { getLayer, getMap } from "@/lib/metadata/maps";
import { datasetInputs, seedReadyTiles } from "@/lib/test-support/tile-evidence";
import { publishMap, unpublishMap } from "@/lib/publish/publish-service";
import { publishedFieldsSignature } from "@/lib/publish/published-fields";
import {
  resetTileBuilds,
  tileBuildsSettled,
  tileFingerprint,
} from "./build";
import { ensureTileDirs, tileArchivePath } from "./paths";
import { currentPublishedTile } from "./published";
import { readTile } from "./serve";

/** The fingerprint exactly as the build path mints it — layer and map read
 * from durable state, the identities the export bound (the one dataset the
 * layer reads), the parity the published gate must reproduce. */
function builtFingerprint(id: string): string {
  const layer = getLayer(id)!;
  const map = getMap(layer.mapId)!;
  return tileFingerprint(
    layer.sql,
    [],
    publishedFieldsSignature(layer, {
      timeline: map.timeline,
      widgets: map.widgets,
      widgetsPublished: map.widgetsPublished,
    }), datasetInputs([pointsId]),
  );
}

/** A ready record with the evidence its build would have written. */
function seedRecord(featureCount: number): void {
  seedReadyTiles(layerId, { fingerprint: builtFingerprint(layerId), featureCount, builtAt }, datasetInputs([pointsId]));
}

let dir: string;
let mapId: string;
let layerId: string;
let token: string;
let pointsId: string;
const sql = "SELECT id, kind, score, geometry FROM points";
const builtAt = "2026-07-14T12:00:00.123Z";

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  const source = path.join(dir, "points.csv");
  await writeFile(source, "id,kind,score,lon,lat\n1,a,10,1,2\n2,b,20,3,4\n");
  pointsId = (await ingestFile(testAccountScope(), source, "points.csv")).id;
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(testAccountScope(), map.id, { name: "l", sql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  layerId = layer.id;
  token = publishMap(testAccountScope(), map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }).token;
  ensureTileDirs();
  await writeFile(tileArchivePath(layerId), "artifact");
  seedRecord(40);
});

afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await rm(dir, { recursive: true, force: true });
});

describe("current published tile eligibility", () => {
  it("keeps a current artifact across style edits and live-filter bound moves", async () => {
    // The live filter exists when the archive is minted; its field is
    // already part of the projection the fingerprint saw.
    await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "score", kind: "range", min: 10, max: 20 }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    seedRecord(40);
    const version = String(Date.parse(builtAt));
    const before = currentPublishedTile(token, layerId, version);
    expect(before?.fingerprint).toBe(builtFingerprint(layerId));

    // Paint and slider bounds never look like data changes: the
    // signature carries field names, not values.
    const layer = getLayer(layerId)!;
    await updateLayer(testAccountScope(), layerId, {
      style: { ...layer.style, opacity: 0.5 },
      filters: [{ field: "score", kind: "range", min: 12, max: 18 }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    expect(currentPublishedTile(token, layerId, version)).toEqual(before);
  });

  it("a new live filter re-fingerprints — its field must reach the wire", async () => {
    const version = String(Date.parse(builtAt));
    expect(currentPublishedTile(token, layerId, version)).not.toBeNull();
    await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "score", kind: "range", min: 10, max: 20 }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    expect(currentPublishedTile(token, layerId, version)).toBeNull();
  });

  it("rejects a superseded server result and an old URL, and serves a current archive whatever its count", async () => {
    const version = String(Date.parse(builtAt));
    expect(currentPublishedTile(token, layerId, "1")).toBeNull();

    await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "kind", kind: "values", values: ["a"] }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    expect(currentPublishedTile(token, layerId, version)).toBeNull();
    closeMetadataDb();
    expect(currentPublishedTile(token, layerId, version)).toBeNull();

    await updateLayer(testAccountScope(), layerId, { filters: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    // An archive minted over the byte limit counts no more features than
    // the cap: current and ready, it is served like any other.
    seedRecord(10);
    expect(currentPublishedTile(token, layerId, version)).not.toBeNull();
  });

  it("uses current publication ownership on every check", () => {
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
    unpublishMap(testAccountScope(), mapId, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision });
    expect(currentPublishedTile(token, layerId, null)).toBeNull();
  });

  it("denies a hidden layer's tiles; visibility restores them", async () => {
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
    await updateLayer(testAccountScope(), layerId, { visible: false }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    // The artifact is retained — the builder may still use it — but the
    // published surface stops serving it.
    expect(currentPublishedTile(token, layerId, null)).toBeNull();
    await updateLayer(testAccountScope(), layerId, { visible: true }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
  });

  it("a built archive carries exactly the effective set and the gate authorizes it — the decoded-tile check", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "1";
    const layer = await updateLayer(testAccountScope(), layerId, { tooltip: ["kind"], popup: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });

    // A real build through the builder lane: the shared archive is minted
    // by the same path both audiences use.
    const kicked = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(kicked.mode).toBe("tiled");
    await tileBuildsSettled();
    const ready = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(ready.tiles?.state).toBe("ready");

    // The parity pair: the published authorization recomputes the
    // fingerprint the build path minted. A drift here 404s every tile.
    const current = currentPublishedTile(token, layerId, null);
    expect(current).not.toBeNull();

    // The decoded-tile check 's tiled half names for promotion: the
    // archive's features carry exactly the effective published field set
    // — the hidden columns are not in the bytes.
    const bytes = await readTile(layerId, 0, 0, 0);
    expect(bytes).not.toBeNull();
    let buf = Buffer.from(bytes!);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    const tile = new VectorTile(new PbfReader(buf));
    const features = tile.layers.features;
    expect(features.length).toBeGreaterThan(0);
    for (let i = 0; i < features.length; i++) {
      expect(Object.keys(features.feature(i).properties)).toEqual(["kind"]);
    }
  });

  it("denies the old artifact while an over-cap SQL replacement prepares", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "1";
    const edited = await updateLayer(testAccountScope(), layerId, {
      sql: `${sql} WHERE id >= 1`,
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });

    expect(currentPublishedTile(token, layerId, null)).toBeNull();
    const replacement = await renderLayer(testAccountScope(), edited, undefined, { tileAccess: privateTileAccess(testAccountScope(), (edited).id) });
    expect(replacement.mode).toBe("tiled");
    expect(replacement.tiles?.state).toBe("building");
  });
});
