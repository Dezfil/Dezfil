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
import { createMap, readMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { lookAtMap, type LookResult } from "./map-look";
import { decodePng, encodePng, type DecodedImage } from "./png-codec";

/**
 * The server's image of a map on a style it took from the basemap library
 * does not change when an admin hides that style and then removes it: the
 * map keeps its own copy of the style's address and credit, and the render
 * page draws the copy. Proved through the real render road on a map that
 * took a loopback library style, a raster style whose tiles paint one
 * colour, with a solid point layer at the centre.
 *
 * In order: the content probes on the first image (the layer's colour at
 * its mark, the style's colour across most of the image), so a blank, flat
 * or default-style image can never pass; a second render, which sets the
 * comparison's tolerance and must itself repeat within 16 per channel on
 * at most 0.5 % of pixels; then the style hidden, and then removed, through
 * the library's operations as an admin, each image compared with the first
 * by its bytes, or within that tolerance, the map's copy unchanged.
 *
 * Provisioning, as the map check's own real-render tests: the port of a
 * production standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, DEZFIL_EGRESS_ALLOWLIST
 * admitting 127.0.0.1 in both processes (the add reads the style through
 * the egress check, and the renderer fetches it and its tiles), and
 * DEZFIL_RENDER_DELEGATION_KEY handed to both. The standalone's
 * DEZFIL_BASEMAP_URL is a loopback style, so a map that falls to the
 * deployment default draws a loopback style, never a public one; the setup
 * refuses to start otherwise. DEZFIL_MAP_LOOK_KEEP names a directory that
 * keeps the four images.
 *
 * The named seed: a reference to the library's row kept in place of the
 * copy, resolved on every read of the map, as a map that pointed at the
 * library would. Hidden, the map then falls to the deployment default,
 * which must fail the image comparison.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const keep = process.env.DEZFIL_MAP_LOOK_KEEP;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
const origin = "http://instance.test";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
const KELP = [26, 93, 74] as const;
/** Every tile of the library's style is one opaque colour, far from the
 * layer's and from the loopback default style's gray. */
const CHART = [48, 96, 196] as const;
const TILE = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...CHART, 255]) });
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

/** One call as an admin, by session cookie, through the shipped route. */
async function asAdmin(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  testAccountScope(metadataDb(), "admin");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  return call(method, pathname, body, headers, "admin");
}
async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, actor?: string) {
  const response = await dispatchAssistantTestRoute(testAccountRequest(new Request(`${origin}${pathname}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), metadataDb(), actor));
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}

describe.skipIf(!port)("the server's image of a map on a library style an admin hid, then removed", () => {
  let mapId: string; let styleId: string | null = null;
  let charts: Server; let styleReads = 0; let tiles = 0;
  let heldKey: unknown;
  let first: Shot | null = null; let tolerance: Difference | null = null;
  let copy: unknown = null;

  beforeAll(async () => {
    const dir = process.env.DEZFIL_DATA_DIR;
    if (!dir) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();

    charts = createServer((req, res) => {
      const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
      if (req.method === "GET" && req.url === "/style.json") {
        styleReads += 1;
        const at = (charts.address() as { port: number }).port;
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ version: 8, sources: { chart: { type: "raster", tiles: [`http://127.0.0.1:${at}/tiles/{z}/{x}/{y}.png`], tileSize: 256,
          attribution: "Chart fixture" } }, layers: [{ id: "chart", type: "raster", source: "chart" }] }));
        return;
      }
      if (req.method === "GET" && /^\/tiles\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
        tiles += 1;
        res.writeHead(200, { "content-type": "image/png", ...cors });
        res.end(Buffer.from(TILE));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => charts.listen(0, "127.0.0.1", resolve));
    const address = charts.address();
    if (!address || typeof address === "string") throw new Error("the style fixture did not listen");

    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${credential}` } });
    if (config.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${config.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    const deployment = (await config.json()).basemapOverrideUrl as string | null;
    if (!deployment || new URL(deployment).hostname !== "127.0.0.1") {
      throw new Error("The standalone's DEZFIL_BASEMAP_URL must be a loopback style, so a map falling to the default fetches nothing public");
    }

    styleId = (await asAdmin("POST", "/api/instance/basemaps", { name: "Chart fixture", url: `http://127.0.0.1:${address.port}/style.json` })).id;
    expect(styleReads, "the add read the style once").toBe(1);
    const scope = testAccountScope();
    const revision = () => readDocumentRevision({ kind: "map", id: mapId })?.editRevision ?? "";
    mapId = createMap(scope, "On a library style").id;
    updateMap(scope, mapId, { viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 } }, { expectedRevision: revision() });
    await call("PATCH", `/api/maps/${mapId}`, { customBasemap: { libraryStyle: styleId } }, { "X-Edit-Revision": revision() });
    expect(styleReads, "the taking read nothing").toBe(1);
    copy = readMap(scope, mapId).customBasemap;
    expect(copy).toEqual({ url: `http://127.0.0.1:${address.port}/style.json`, name: "Chart fixture", attribution: [{ label: "Chart fixture" }] });
    await createLayer(scope, mapId, { name: "Kelp", sql: `SELECT ST_Point(${LNG0}, ${LAT0}) AS geom`, style: solid(KELP, 10) }, { expectedRevision: revision() });
  }, 120_000);
  afterAll(async () => {
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    await new Promise((resolve) => charts?.close(resolve));
    vi.unstubAllEnvs();
  });

  const look = async (label: string): Promise<Shot> => {
    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const result = await lookAtMap(testAccountScope(), { mapId, credential, baseUrl: `http://127.0.0.1:${port}` });
    console.info(JSON.stringify({ look: label, image: result.image.width + "x" + result.image.height, bytes: result.image.bytes, elapsedMs: result.elapsedMs, styleReads, tiles, failures: result.composition.failures, abandoned: result.composition.abandoned }));
    if (keep) await writeFile(path.join(keep, `library-${label}.png`), result.image.png);
    return { result, decoded: decodePng(result.image.png) };
  };
  const unchanged = async (label: string) => {
    expect(first, "the first image's content was not established").not.toBeNull();
    expect(tolerance, "the renders' repeatability was not measured").not.toBeNull();
    const after = await look(label);
    const drift = difference(first!, after);
    console.info(JSON.stringify({ look: label, comparison: drift, tolerance }));
    if (!drift.identical) {
      expect(drift.maxChannel, "the image moved past the repeatability run's tolerance per channel").toBeLessThanOrEqual(tolerance!.maxChannel);
      expect(drift.share, "the image moved on more pixels than the repeatability run's tolerance").toBeLessThanOrEqual(tolerance!.share);
    }
    expect(after.result.state.digest).toBe(first!.result.state.digest);
    expect(readMap(testAccountScope(), mapId).customBasemap, "the map's copy").toEqual(copy);
  };

  it("draws the library style across the image and the layer's colour at its mark", async () => {
    const shot = await look("first");
    expect(shot.result.image).toMatchObject({ width: 1024, height: 640 });
    expect(shot.result.composition.failures).toEqual([]);
    expect(count(shot.decoded, around(512, 320), isColour(KELP)), "the layer's mark at the centre").toBeGreaterThan(120);
    expect(count(shot.decoded, WHOLE, isColour(CHART)), "the library style across most of the image").toBeGreaterThan(1024 * 640 * 0.6);
    expect(tiles, "the style fixture served the tiles").toBeGreaterThan(0);
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

  it("draws the same image after an admin hid the style", async () => {
    await asAdmin("PATCH", `/api/instance/basemaps/${styleId}`, { offered: false });
    await unchanged("hidden");
  }, 60_000);

  it("draws the same image after an admin removed the style", async () => {
    await asAdmin("DELETE", `/api/instance/basemaps/${styleId}`);
    styleId = null;
    await unchanged("removed");
  }, 60_000);
});
