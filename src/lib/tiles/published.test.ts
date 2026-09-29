import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer } from "@/lib/layer-service";
import { getLayer, getMap } from "@/lib/metadata/maps";
import { upsertTileRecord } from "@/lib/metadata/tiles";
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
 * from durable state, the parity the published gate must reproduce. */
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
    }), id,
  );
}

let dir: string;
let mapId: string;
let layerId: string;
let token: string;
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
  await ingestFile(testAccountScope(), source, "points.csv");
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(testAccountScope(), map.id, { name: "l", sql });
  layerId = layer.id;
  token = publishMap(testAccountScope(), map.id).token;
  ensureTileDirs();
  await writeFile(tileArchivePath(layerId), "artifact");
  upsertTileRecord({
    layerId,
    state: "ready",
    fingerprint: builtFingerprint(layerId),
    error: null,
    featureCount: 40,
    builtAt,
  });
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
    });
    upsertTileRecord({
      layerId,
      state: "ready",
      fingerprint: builtFingerprint(layerId),
      error: null,
      featureCount: 40,
      builtAt,
    });
    const version = String(Date.parse(builtAt));
    const before = currentPublishedTile(token, layerId, version);
    expect(before?.fingerprint).toBe(builtFingerprint(layerId));

    // Paint and slider bounds never look like data changes: the
    // signature carries field names, not values.
    const layer = getLayer(layerId)!;
    await updateLayer(testAccountScope(), layerId, {
      style: { ...layer.style, opacity: 0.5 },
      filters: [{ field: "score", kind: "range", min: 12, max: 18 }],
    });
    expect(currentPublishedTile(token, layerId, version)).toEqual(before);
  });

  it("a new live filter re-fingerprints — its field must reach the wire", async () => {
    const version = String(Date.parse(builtAt));
    expect(currentPublishedTile(token, layerId, version)).not.toBeNull();
    await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "score", kind: "range", min: 10, max: 20 }],
    });
    expect(currentPublishedTile(token, layerId, version)).toBeNull();
  });

  it("rejects a superseded server result, an inline artifact, and an old URL", async () => {
    const version = String(Date.parse(builtAt));
    expect(currentPublishedTile(token, layerId, "1")).toBeNull();

    await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "kind", kind: "values", values: ["a"] }],
    });
    expect(currentPublishedTile(token, layerId, version)).toBeNull();
    closeMetadataDb();
    expect(currentPublishedTile(token, layerId, version)).toBeNull();

    await updateLayer(testAccountScope(), layerId, { filters: [] });
    upsertTileRecord({
      layerId,
      state: "ready",
      fingerprint: builtFingerprint(layerId),
      error: null,
      featureCount: 10,
      builtAt,
    });
    expect(currentPublishedTile(token, layerId, version)).toBeNull();
  });

  it("uses current publication ownership on every check", () => {
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
    unpublishMap(testAccountScope(), mapId);
    expect(currentPublishedTile(token, layerId, null)).toBeNull();
  });

  it("denies a hidden layer's tiles; visibility restores them", async () => {
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
    await updateLayer(testAccountScope(), layerId, { visible: false });
    // The artifact is retained — the builder may still use it — but the
    // published surface stops serving it.
    expect(currentPublishedTile(token, layerId, null)).toBeNull();
    await updateLayer(testAccountScope(), layerId, { visible: true });
    expect(currentPublishedTile(token, layerId, null)).not.toBeNull();
  });

  it("a built archive carries exactly the effective set and the gate authorizes it — the decoded-tile check", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "1";
    const layer = await updateLayer(testAccountScope(), layerId, { tooltip: ["kind"], popup: [] });

    // A real build through the builder lane: the shared archive is minted
    // by the same path both audiences use.
    const kicked = await renderLayer(layer);
    expect(kicked.mode).toBe("tiled");
    await tileBuildsSettled();
    const ready = await renderLayer(layer);
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
    const tile = new VectorTile(new Pbf(buf));
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
    });

    expect(currentPublishedTile(token, layerId, null)).toBeNull();
    const replacement = await renderLayer(edited);
    expect(replacement.mode).toBe("tiled");
    expect(replacement.tiles?.state).toBe("building");
  });
});
