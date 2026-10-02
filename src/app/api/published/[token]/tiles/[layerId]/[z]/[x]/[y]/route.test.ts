import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const readTileMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tiles/serve", () => ({ readTile: readTileMock }));

import { closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { getLayer } from "@/lib/metadata/maps";
import { datasetInputs, seedReadyTiles } from "@/lib/test-support/tile-evidence";
import { publishMap, unpublishMap } from "@/lib/publish/publish-service";
import { publishedFieldsSignature } from "@/lib/publish/published-fields";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import { tileFingerprint } from "@/lib/tiles/build";
import { ensureTileDirs, tileArchivePath } from "@/lib/tiles/paths";
import { currentPublishedTile } from "@/lib/tiles/published";
import { GET } from "./route";
import { GET as getPublishedViewRoute } from "../../../../../route";

let dir: string;
let mapId: string;
let layerId: string;
let token: string;
let version: string;
const sql = "SELECT id, geometry FROM points";

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_RENDER_CAP_FEATURES = "1";
  closeMetadataDb();
  resetQueryInstance();
  resetRateLimits();
  readTileMock.mockReset();
  const source = path.join(dir, "points.csv");
  await writeFile(source, "id,lon,lat\n1,1,2\n2,3,4\n");
  const points = await ingestFile(testAccountScope(), source, "points.csv");
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(testAccountScope(), map.id, { name: "l", sql });
  layerId = layer.id;
  token = publishMap(testAccountScope(), map.id).token;
  const builtAt = "2026-07-14T12:00:00.123Z";
  version = String(Date.parse(builtAt));
  ensureTileDirs();
  await writeFile(tileArchivePath(layerId), "artifact");
  const built = getLayer(layerId)!;
  // Exactly as the build path mints it, with the evidence it writes — the
  // parity the route's authorization must reproduce.
  const inputs = datasetInputs([points.id]);
  seedReadyTiles(layerId, {
    fingerprint: tileFingerprint(
      sql,
      [],
      publishedFieldsSignature(built, {
        timeline: map.timeline,
        widgets: map.widgets,
        widgetsPublished: map.widgetsPublished,
      }), inputs,
    ),
    featureCount: 2,
    builtAt,
  }, inputs);
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await rm(dir, { recursive: true, force: true });
});

function request(headers?: HeadersInit, requestedVersion = version) {
  return new Request(
    `http://localhost/api/published/${token}/tiles/${layerId}/0/0/0?v=${requestedVersion}`,
    { headers },
  );
}

function context() {
  return {
    params: Promise.resolve({ token, layerId, z: "0", x: "0", y: "0" }),
  };
}

describe("published tile route", () => {
  it("marks the published JSON response private and non-storable", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    const response = await getPublishedViewRoute(
      new Request(`http://localhost/api/published/${token}`),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("revalidates a current artifact only after authorization", async () => {
    const artifact = currentPublishedTile(token, layerId, version)!;
    const response = await GET(request({ "if-none-match": artifact.etag }), context());
    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
    expect(readTileMock).not.toHaveBeenCalled();

    const old = await GET(request(undefined, "1"), context());
    expect(old.status).toBe(404);
    expect(old.headers.get("cache-control")).toBe("private, no-store");
  });

  it("discards bytes if revocation crosses the archive read", async () => {
    let release!: (tile: Uint8Array) => void;
    readTileMock.mockImplementation(
      () => new Promise<Uint8Array>((resolve) => (release = resolve)),
    );
    const inFlight = GET(request(), context());
    await vi.waitFor(() => expect(readTileMock).toHaveBeenCalledOnce());

    unpublishMap(testAccountScope(), mapId);
    release(new Uint8Array([1, 2, 3]));

    const response = await inFlight;
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
