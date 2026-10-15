import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver: the one name
// the imagery may take here answers as the step says, every other name
// does not resolve. The renderer's guard and relay run in this process,
// so a page reaching for a host asks this resolver too, and the browser
// resolves nothing; so does the export's check of the imagery's host
// before the render. The imagery's tiles are fetched by the standalone,
// which resolves with its own.
const dns = vi.hoisted(() => ({ answer: [] as { address: string; family: number }[], asked: [] as string[] }));
vi.mock("node:dns/promises", () => ({
  lookup: async (name: string) => {
    dns.asked.push(name);
    if (name === "imagery.fixture.test" && dns.answer.length) return dns.answer;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  },
}));

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
import { resetSecretKeyCache } from "@/lib/secrets";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { lookAtMap } from "./map-look";
import { decodePng, encodePng, type DecodedImage } from "./png-codec";

/**
 * The server's image of a map on Satellite as an admin sets the imagery
 * up, as the instance's key changes under it, as the admin removes it and
 * sets it again, and as its tile host turns private after the save.
 *
 * Proved through the real render road on a map on Satellite with a solid
 * point layer at the centre: the imagery is a loopback tile fixture painting
 * every tile one colour, and the deployment default is a loopback gray
 * style. While a readable template is set the image is the imagery's colour
 * across most of it; once the template is removed, or stored under a key
 * the instance no longer holds, the map keeps its choice and the image is
 * the default style's gray, the imagery asked for nothing; set again, the
 * imagery is back. The page draws the imagery from the instance's own tile
 * address, which the standalone answers from the template: the imagery
 * style names no part of the template, the fixture sends no cross-origin
 * permission (a page fetching it directly would draw nothing), and every
 * tile it serves is asked by the server, never by the browser. A tile host
 * a fixture resolver answers publicly at save and privately at use is
 * refused by the export's egress check of the imagery's host: the image is
 * not produced and the export answers the egress refusal, the imagery
 * asked for nothing. A tile host that passes that check and redirects its
 * tiles to a private address is refused by the standalone's relay while
 * the image renders: its refusal carries the outbound policy's mark, and
 * the export answers the same refusal rather than an image without its
 * imagery.
 *
 * Provisioning, as the map check's other real-render tests: the port of a
 * production standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, DEZFIL_EGRESS_ALLOWLIST
 * admitting 127.0.0.1 in both processes (the template is stored through
 * the save-time check here, and the standalone fetches its tiles),
 * DEZFIL_RENDER_DELEGATION_KEY and
 * DEZFIL_SECRET_KEY handed to both, and the standalone's DEZFIL_BASEMAP_URL
 * at the loopback gray style, so a map falling to the default fetches
 * nothing public; the setup refuses to start otherwise.
 * DEZFIL_MAP_LOOK_KEEP names a directory that keeps the images.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const keep = process.env.DEZFIL_MAP_LOOK_KEEP;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
const origin = "http://instance.test";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
const KELP = [26, 93, 74] as const;
/** Every imagery tile is one opaque colour, far from the layer's and from
 * the default style's gray. */
const IMAGERY = [196, 72, 48] as const;
/** The loopback default style's every tile. */
const GRAY = [240, 240, 240] as const;
const TILE = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...IMAGERY, 255]) });
const EGRESS_REFUSAL = "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced.";
const solid = (c: readonly [number, number, number], radius: number) => ({ fill: { type: "constant" as const, color: { r: c[0], g: c[1], b: c[2], a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: radius, opacity: 1 });
const near = (v: number, t: number) => Math.abs(v - t) <= 16;
const isColour = (c: readonly [number, number, number]) => (r: number, g: number, b: number) => near(r, c[0]) && near(g, c[1]) && near(b, c[2]);

function count(image: DecodedImage, predicate: (r: number, g: number, b: number) => boolean, around?: { x: number; y: number; r: number }): number {
  const [x0, y0, x1, y1] = around ? [around.x - around.r, around.y - around.r, around.x + around.r, around.y + around.r] : [0, 0, image.width, image.height];
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y += 1) for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x += 1) {
    const i = (y * image.width + x) * 4;
    if (predicate(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) n += 1;
  }
  return n;
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

describe.skipIf(!port)("the server's image of a map on Satellite as the imagery is set, unreadable, removed and set again", () => {
  let mapId: string;
  let imagery: Server; let tiles = 0; let redirects = 0; let imageryPort = 0;
  /** The user agent of every tile request the fixture served. */
  const askedBy: string[] = [];
  let heldKey: unknown; let changed = false;
  const instanceKey = process.env.DEZFIL_SECRET_KEY;
  const credential = () => delegateCredential(requireRequestAuth(authenticatedRequest()));
  const template = (host = "127.0.0.1") => `http://${host}:${imageryPort}/tiles/{z}/{x}/{y}.png`;

  beforeAll(async () => {
    if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    if (!/^[0-9a-f]{64}$/i.test(process.env.DEZFIL_SECRET_KEY ?? "")) throw new Error("DEZFIL_SECRET_KEY must carry the standalone's instance key, so this process stores what it reads");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache();

    imagery = createServer((req, res) => {
      if (req.method === "GET" && /^\/tiles\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
        tiles += 1;
        askedBy.push(req.headers["user-agent"] ?? "");
        // No cross-origin permission: only the instance's own fetch draws it.
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(Buffer.from(TILE));
        return;
      }
      if (req.method === "GET" && /^\/redirect\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
        // Sent on to a private address, which the outbound policy refuses.
        redirects += 1;
        res.writeHead(302, { location: `http://10.0.0.7${(req.url ?? "").replace("/redirect/", "/tiles/")}` });
        res.end();
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => imagery.listen(0, "127.0.0.1", resolve));
    const address = imagery.address();
    if (!address || typeof address === "string") throw new Error("the imagery fixture did not listen");
    imageryPort = address.port;

    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${credential()}` } });
    if (config.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${config.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    const deployment = (await config.json()).basemapOverrideUrl as string | null;
    if (!deployment || new URL(deployment).hostname !== "127.0.0.1") {
      throw new Error("The standalone's DEZFIL_BASEMAP_URL must be a loopback style, so a map falling to the default fetches nothing public");
    }

    changed = true;
    const scope = testAccountScope();
    const revision = () => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });
    await change({ satelliteUrl: template(), satelliteAttribution: "Imagery fixture" });
    mapId = createMap(scope, "On the imagery as it comes and goes").id;
    updateMap(scope, mapId, { viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 }, basemap: "satellite" }, revision());
    await createLayer(scope, mapId, { name: "Kelp", sql: `SELECT ST_Point(${LNG0}, ${LAT0}) AS geom`, style: solid(KELP, 10) }, revision());
  }, 120_000);
  afterAll(async () => {
    vi.stubEnv("DEZFIL_SECRET_KEY", instanceKey); resetSecretKeyCache();
    if (changed) await change({ satelliteUrl: null, satelliteAttribution: null });
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    await new Promise((resolve) => imagery?.close(resolve));
    vi.unstubAllEnvs();
  });

  /** One render of the map, with how many imagery tiles it asked for. */
  const look = async (label: string) => {
    const before = tiles;
    const result = await lookAtMap(testAccountScope(), { mapId, credential: credential(), baseUrl: `http://127.0.0.1:${port}` });
    const asked = tiles - before;
    console.info(JSON.stringify({ look: label, image: `${result.image.width}x${result.image.height}`, bytes: result.image.bytes, elapsedMs: result.elapsedMs, imageryTiles: asked, failures: result.composition.failures, abandoned: result.composition.abandoned }));
    if (keep) await writeFile(path.join(keep, `satellite-${label}.png`), result.image.png);
    return { result, decoded: decodePng(result.image.png), asked };
  };
  /** The standalone's imagery style, as a signed-in render asks for it. */
  const imageryStyle = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/basemaps/satellite`, { headers: { authorization: `Bearer ${credential()}` } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  /** The style served, naming the instance's own tile address and no part of the template. */
  const servedStyle = async () => {
    const style = await imageryStyle();
    expect(style.status).toBe(200);
    expect((style.body as { sources: { satellite: { tiles: string[] } } }).sources.satellite.tiles).toEqual(["/api/basemaps/satellite/tiles/{z}/{x}/{y}{ratio}"]);
    expect(JSON.stringify(style.body)).not.toContain(`:${imageryPort}`);
  };
  const mapRecord = () => metadataDb().prepare("SELECT basemap FROM maps WHERE id = ?").get(mapId);
  const imageryDrawn = (shot: Awaited<ReturnType<typeof look>>) => {
    expect(shot.result.composition.failures).toEqual([]);
    expect(count(shot.decoded, isColour(KELP), { x: 512, y: 320, r: 22 }), "the layer's mark at the centre").toBeGreaterThan(120);
    expect(count(shot.decoded, isColour(IMAGERY)), "the imagery across most of the image").toBeGreaterThan(1024 * 640 * 0.6);
    expect(shot.asked, "the imagery fixture served the tiles").toBeGreaterThan(0);
    expect(askedBy.filter((agent) => /HeadlessChrome|Mozilla/.test(agent)), "tiles asked by the browser").toEqual([]);
  };
  // The default style's gray to within rounding: the offline fallback's
  // light ground is near it, and a map still pointed at the imagery style
  // falls to that fallback rather than the default.
  const isDefaultGray = (r: number, g: number, b: number) => [r, g, b].every((v, i) => Math.abs(v - GRAY[i]) <= 2);
  const defaultDrawn = (shot: Awaited<ReturnType<typeof look>>) => {
    expect(count(shot.decoded, isColour(KELP), { x: 512, y: 320, r: 22 }), "the layer's mark at the centre").toBeGreaterThan(120);
    expect(count(shot.decoded, isDefaultGray), "the default style's gray across most of the image").toBeGreaterThan(1024 * 640 * 0.6);
    expect(shot.result.attribution, "no credit for imagery the image does not draw").not.toContain("Imagery fixture");
    expect(count(shot.decoded, isColour(IMAGERY)), "no imagery").toBe(0);
    expect(shot.asked, "the imagery fixture asked for nothing").toBe(0);
  };

  it("draws the imagery under the layer while a readable template is set", async () => {
    await servedStyle();
    imageryDrawn(await look("set"));
  }, 60_000);

  it("draws the default style once the template is removed, the map keeping its choice and the imagery style not served", async () => {
    await change({ satelliteUrl: null });
    expect(mapRecord()).toEqual({ basemap: "satellite" });
    expect((await imageryStyle()).status).toBe(404);
    defaultDrawn(await look("removed"));
  }, 60_000);

  it("draws the default style while the stored template is one the instance's key no longer opens, the imagery style refusing by its code", async () => {
    // Stored under another key: to the instance, its key changed after the save.
    vi.stubEnv("DEZFIL_SECRET_KEY", "6f".repeat(32)); resetSecretKeyCache();
    try { await change({ satelliteUrl: template() }); }
    finally { vi.stubEnv("DEZFIL_SECRET_KEY", instanceKey); resetSecretKeyCache(); }
    const refused = await imageryStyle();
    expect(refused).toEqual({ status: 400, body: { error: { code: "service_address_unreadable", message: expect.stringContaining('"Satellite template"') } } });
    expect(JSON.stringify(refused.body)).not.toContain(`:${imageryPort}`);
    expect(mapRecord()).toEqual({ basemap: "satellite" });
    defaultDrawn(await look("unreadable"));
  }, 60_000);

  it("draws the imagery again once a template is set again", async () => {
    await change({ satelliteUrl: template() });
    await servedStyle();
    imageryDrawn(await look("set-again"));
  }, 60_000);

  it("refuses the image of a map at a tile host answered publicly at save and privately at use, with the renderer's egress refusal, the imagery asked for nothing", async () => {
    dns.answer = [{ address: "203.0.113.10", family: 4 }];
    await change({ satelliteUrl: template("imagery.fixture.test") });
    expect(dns.asked).toContain("imagery.fixture.test");
    dns.answer = [{ address: "10.0.0.7", family: 4 }];
    dns.asked = [];
    const before = tiles;
    await expect(lookAtMap(testAccountScope(), { mapId, credential: credential(), baseUrl: `http://127.0.0.1:${port}` }))
      .rejects.toMatchObject({ code: "render_failed", message: EGRESS_REFUSAL });
    // The export asked the resolver at use, and nothing reached the imagery.
    expect(dns.asked).toContain("imagery.fixture.test");
    expect(tiles - before).toBe(0);
  }, 60_000);

  it("refuses the image of a map whose imagery redirects its tiles to an address the outbound policy refuses, with the renderer's egress refusal", async () => {
    await change({ satelliteUrl: `http://127.0.0.1:${imageryPort}/redirect/{z}/{x}/{y}.png` });
    const before = { tiles, redirects };
    await expect(lookAtMap(testAccountScope(), { mapId, credential: credential(), baseUrl: `http://127.0.0.1:${port}` }))
      .rejects.toMatchObject({ code: "render_failed", message: EGRESS_REFUSAL });
    // The host passed the check before the render, its tiles were asked and
    // redirected, and nothing was asked at the address they were sent to.
    expect(redirects - before.redirects, "tiles asked and redirected").toBeGreaterThan(0);
    expect(tiles - before.tiles).toBe(0);
  }, 60_000);
});
