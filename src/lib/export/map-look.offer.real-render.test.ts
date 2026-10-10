import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { GET as readConfig } from "@/app/api/config/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { lookAtMap, type LookResult } from "./map-look";
import { decodePng, encodePng, type DecodedImage } from "./png-codec";

/**
 * The server's image of a map on a style an admin hid does not change: the
 * render page draws every style a map may be on, while only the surfaces
 * where a basemap is chosen leave the hidden one out. Proved through the
 * real render road on a map on Satellite, the one style an instance points
 * at its own server, here a loopback tile fixture painting every tile one
 * colour, with a solid point layer at the centre.
 *
 * In order: the content probes on the first image (the layer's colour at
 * its mark, the imagery's colour across most of the image), so a blank,
 * flat or default-style image can never pass; a second render, which sets
 * the comparison's tolerance and must itself repeat within 16 per channel
 * on at most 0.5 % of pixels, or the comparison is unmeasurable and fails
 * rather than widen; then Satellite hidden through the change operation as
 * an admin, the runtime read leaving it out, and the image compared with
 * the first by its bytes, or within that tolerance, the map still on it.
 *
 * Provisioning, as the map check's own real-render tests: the port of a
 * production standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, DEZFIL_EGRESS_ALLOWLIST
 * admitting 127.0.0.1 in both processes (the template is stored through
 * the save-time check, and the renderer fetches its tiles), and
 * DEZFIL_RENDER_DELEGATION_KEY handed to both as those headers say. One
 * more: the standalone's DEZFIL_BASEMAP_URL at a loopback style, so a map
 * that falls to the deployment default draws a loopback style, never a
 * public one; the setup refuses to start otherwise. DEZFIL_MAP_LOOK_KEEP
 * names a directory that keeps the three images.
 *
 * The named seed: the render page built to read the offer in place of the
 * drawing list, as a drawing surface taking the choosing list would. The
 * map then falls to the deployment default once Satellite is hidden, which
 * must fail the image comparison.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const keep = process.env.DEZFIL_MAP_LOOK_KEEP;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
const origin = "http://instance.test";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
const KELP = [26, 93, 74] as const;
/** Every imagery tile is one opaque colour, far from the layer's and from
 * the loopback default style's gray. */
const IMAGERY = [196, 72, 48] as const;
const TILE = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...IMAGERY, 255]) });
const solid = (c: readonly [number, number, number], radius: number) => ({ fill: { type: "constant" as const, color: { r: c[0], g: c[1], b: c[2], a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: radius, opacity: 1 });
const near = (v: number, t: number) => Math.abs(v - t) <= 16;
const isColour = (c: readonly [number, number, number]) => (r: number, g: number, b: number) => near(r, c[0]) && near(g, c[1]) && near(b, c[2]);

interface Region { x0: number; y0: number; x1: number; y1: number }
function count(image: DecodedImage, region: Region, predicate: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = Math.max(0, region.y0); y < Math.min(image.height, region.y1); y += 1) for (let x = Math.max(0, region.x0); x < Math.min(image.width, region.x1); x += 1) {
    const i = (y * image.width + x) * 4;
    if (predicate(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) n += 1;
  }
  return n;
}
const around = (x: number, y: number, r = 22): Region => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
const WHOLE: Region = { x0: 0, y0: 0, x1: 1024, y1: 640 };

type Shot = { result: LookResult; decoded: DecodedImage };
interface Difference { identical: boolean; pixels: number; share: number; maxChannel: number }
function difference(a: Shot, b: Shot): Difference {
  const identical = Buffer.from(a.result.image.png).equals(Buffer.from(b.result.image.png));
  expect([b.decoded.width, b.decoded.height]).toEqual([a.decoded.width, a.decoded.height]);
  let pixels = 0, maxChannel = 0;
  for (let i = 0; i < a.decoded.rgba.length; i += 4) {
    let most = 0;
    for (let c = 0; c < 4; c += 1) most = Math.max(most, Math.abs(a.decoded.rgba[i + c] - b.decoded.rgba[i + c]));
    if (most > 0) { pixels += 1; maxChannel = Math.max(maxChannel, most); }
  }
  return { identical, pixels, share: pixels / (a.decoded.width * a.decoded.height), maxChannel };
}

/** The change operation as an admin; null resets a value. */
async function change(patch: Record<string, unknown>) {
  testAccountScope(metadataDb(), "admin");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const response = await changeInstanceSettings(testAccountRequest(new Request(`${origin}/api/instance/settings`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }), metadataDb(), "admin"));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}
async function offered(): Promise<string[]> {
  const response = await readConfig(testAccountRequest(new Request(`${origin}/api/config`)));
  expect(response.status).toBe(200);
  return ((await response.json()).basemaps as { key: string }[]).map((b) => b.key);
}

describe.skipIf(!port)("the server's image of a map on a style an admin hid", () => {
  let mapId: string;
  let imagery: Server; let tiles = 0;
  let heldKey: unknown; let changed = false;
  let first: Shot | null = null; let tolerance: Difference | null = null;

  beforeAll(async () => {
    const dir = process.env.DEZFIL_DATA_DIR;
    if (!dir) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();

    imagery = createServer((req, res) => {
      if (req.method === "GET" && /^\/tiles\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
        tiles += 1;
        res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*", "cache-control": "no-store" });
        res.end(Buffer.from(TILE));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => imagery.listen(0, "127.0.0.1", resolve));
    const address = imagery.address();
    if (!address || typeof address === "string") throw new Error("the imagery fixture did not listen");

    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${credential}` } });
    if (config.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${config.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    const deployment = (await config.json()).basemapOverrideUrl as string | null;
    if (!deployment || new URL(deployment).hostname !== "127.0.0.1") {
      throw new Error("The standalone's DEZFIL_BASEMAP_URL must be a loopback style, so a map falling to the default fetches nothing public");
    }

    changed = true;
    await change({ satelliteUrl: `http://127.0.0.1:${address.port}/tiles/{z}/{x}/{y}.png`, satelliteAttribution: "Imagery fixture" });
    expect(await offered()).toContain("satellite");
    const scope = testAccountScope();
    const revision = () => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });
    mapId = createMap(scope, "On the imagery before it was hidden").id;
    updateMap(scope, mapId, { viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 }, basemap: "satellite" }, revision());
    await createLayer(scope, mapId, { name: "Kelp", sql: `SELECT ST_Point(${LNG0}, ${LAT0}) AS geom`, style: solid(KELP, 10) }, revision());
  }, 120_000);
  afterAll(async () => {
    if (changed) await change({ satelliteUrl: null, satelliteAttribution: null, "basemaps.satellite": null });
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    await new Promise((resolve) => imagery?.close(resolve));
    vi.unstubAllEnvs();
  });

  const look = async (label: string): Promise<Shot> => {
    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const result = await lookAtMap(testAccountScope(), { mapId, credential, baseUrl: `http://127.0.0.1:${port}` });
    console.info(JSON.stringify({ look: label, image: result.image.width + "x" + result.image.height, bytes: result.image.bytes, elapsedMs: result.elapsedMs, tiles, failures: result.composition.failures, abandoned: result.composition.abandoned }));
    if (keep) await writeFile(path.join(keep, `offer-${label}.png`), result.image.png);
    return { result, decoded: decodePng(result.image.png) };
  };

  it("draws the imagery across the image and the layer's colour at its mark, while Satellite is offered", async () => {
    const shot = await look("first");
    expect(shot.result.image).toMatchObject({ width: 1024, height: 640 });
    expect(shot.result.composition.failures).toEqual([]);
    expect(count(shot.decoded, around(512, 320), isColour(KELP)), "the layer's mark at the centre").toBeGreaterThan(120);
    expect(count(shot.decoded, WHOLE, isColour(IMAGERY)), "the imagery across most of the image").toBeGreaterThan(1024 * 640 * 0.6);
    expect(tiles, "the imagery fixture served the tiles").toBeGreaterThan(0);
    first = shot;
  }, 60_000);

  it("draws the same map again, within 16 per channel on at most 0.5 % of pixels", async () => {
    expect(first, "the first image's content was not established").not.toBeNull();
    const repeat = difference(first!, await look("second"));
    console.info(JSON.stringify({ repeatability: repeat }));
    expect(repeat.maxChannel, "two renders of one map differ past 16 per channel: the comparison is unmeasurable").toBeLessThanOrEqual(16);
    expect(repeat.share, "two renders of one map differ on more than 0.5 % of pixels: the comparison is unmeasurable").toBeLessThanOrEqual(0.005);
    tolerance = repeat;
  }, 60_000);

  it("draws the same image after an admin hid Satellite, the map kept on it", async () => {
    expect(first, "the first image's content was not established").not.toBeNull();
    expect(tolerance, "the renders' repeatability was not measured").not.toBeNull();
    await change({ "basemaps.satellite": false });
    expect(await offered()).not.toContain("satellite");
    const after = await look("after");
    const drift = difference(first!, after);
    console.info(JSON.stringify({ comparison: drift, tolerance }));
    if (!drift.identical) {
      expect(drift.maxChannel, "the image moved past the repeatability run's tolerance per channel").toBeLessThanOrEqual(tolerance!.maxChannel);
      expect(drift.share, "the image moved on more pixels than the repeatability run's tolerance").toBeLessThanOrEqual(tolerance!.share);
    }
    expect(after.result.state.digest).toBe(first!.result.state.digest);
    expect(metadataDb().prepare("SELECT basemap FROM maps WHERE id = ?").get(mapId)).toEqual({ basemap: "satellite" });
  }, 60_000);
});
