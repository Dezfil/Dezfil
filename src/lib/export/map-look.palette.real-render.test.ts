import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
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
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { lookAtMap, type LookResult } from "./map-look";
import { decodePng, type DecodedImage } from "./png-codec";

/**
 * A layer classified with a saved palette keeps its colors, and the
 * server's image of its map, once the palette is deleted: classification
 * writes the class colors into the layer's style, so the palette's name
 * there is only a label. Proved through the real render road on a map of
 * three points, one per class of a saved three-color palette, on the
 * loopback default style.
 *
 * In order: the palette saved and the layer classified with it through the
 * shipped operations; the content probes on the first image (each point a
 * color of its own, none the ground's), so a blank or unclassified image
 * can never pass; a second render, which sets the comparison's tolerance
 * and must itself repeat within 16 per channel on at most 0.5 % of pixels;
 * then the palette deleted through its operation, the layer's colors and
 * the image compared with the first.
 *
 * Provisioning, as the library's real-render test: the port of a production
 * standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, DEZFIL_RENDER_DELEGATION_KEY
 * handed to both, and a loopback DEZFIL_BASEMAP_URL on the standalone, so
 * the map, on Auto, draws a loopback style; the setup refuses to start
 * otherwise. DEZFIL_MAP_LOOK_KEEP names a directory that keeps the images.
 *
 * The named seed, DEZFIL_PALETTE_SEED=recolor: the deletion followed by
 * what a deletion that reached the layers using the palette would do, the
 * layer classified again on the default ramp. The comparison must fail.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const keep = process.env.DEZFIL_MAP_LOOK_KEEP;
const recolor = process.env.DEZFIL_PALETTE_SEED === "recolor";
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
const origin = "http://instance.test";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
/** The points sit this far either side of the centre: 291 px at zoom 12. */
const STEP = 0.05;
const MARKS = [[512 - 291, 320], [512, 320], [512 + 291, 320]] as const;
const RAMP = ["#d7301f", "#1f78b4", "#f2c400"];

interface Region { x0: number; y0: number; x1: number; y1: number }
const around = (x: number, y: number, r: number): Region => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
/** The most common color in a region. */
function commonest(image: DecodedImage, region: Region): [number, number, number] {
  const seen = new Map<string, number>();
  for (let y = region.y0; y < region.y1; y += 1) for (let x = region.x0; x < region.x1; x += 1) {
    const i = (y * image.width + x) * 4;
    const key = `${image.rgba[i]},${image.rgba[i + 1]},${image.rgba[i + 2]}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const [key] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return key.split(",").map(Number) as [number, number, number];
}
const apart = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));

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

/** One call as this process's account, by session cookie, through the shipped route. */
async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await dispatchAssistantTestRoute(testAccountRequest(new Request(`${origin}${pathname}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), metadataDb()));
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}

describe.skipIf(!port)("the server's image of a map whose layer was classified with a palette since deleted", () => {
  let mapId: string; let layerId: string; let palette: { name: string; label: string };
  let heldKey: unknown;
  let first: Shot | null = null; let tolerance: Difference | null = null;
  let fill: unknown = null;
  const revision = () => readDocumentRevision({ kind: "map", id: mapId })?.editRevision ?? "";
  const layerFill = async () => (await call("GET", `/api/layers/${layerId}`)).style.fill;

  beforeAll(async () => {
    if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();

    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${credential}` } });
    if (config.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${config.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    const deployment = (await config.json()).basemapOverrideUrl as string | null;
    if (!deployment || new URL(deployment).hostname !== "127.0.0.1") {
      throw new Error("The standalone's DEZFIL_BASEMAP_URL must be a loopback style, so the map's Auto basemap fetches nothing public");
    }

    palette = await call("POST", "/api/palettes", { label: "Three classes", stops: RAMP.map((color, index) => ({ color, position: index / 2 })) });
    const scope = testAccountScope();
    mapId = createMap(scope, "Classified with a saved palette").id;
    updateMap(scope, mapId, { viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 } }, { expectedRevision: revision() });
    // Values 1 to 9: the three drawn points hold 1, 5 and 9, one in each class; the rest lie far outside the view.
    const drawn = new Map([[1, -STEP], [5, 0], [9, STEP]]);
    const points = Array.from({ length: 9 }, (_, index) => index + 1)
      .map(value => `(ST_Point(${LNG0 + (drawn.get(value) ?? 2 + value)}, ${LAT0}), ${value})`).join(", ");
    const layer = await createLayer(scope, mapId, { name: "Classes", sql: `SELECT geom, v FROM (VALUES ${points}) AS t(geom, v)` }, { expectedRevision: revision() });
    layerId = layer.id;
    const classified = await call("POST", `/api/layers/${layerId}/fill`, { attribute: "v", method: "quantile", palette: palette.name, classes: 3 });
    expect(classified, "classified with the saved palette").toMatchObject({ type: "quantile", palette: palette.name });
    expect(classified.colors, "one color per class").toHaveLength(3);
    await call("PATCH", `/api/layers/${layerId}`, { style: { ...layer.style, fill: classified, fillOpacity: 1, pointRadius: 14, strokeWidth: 0, opacity: 1 } },
      { "X-Edit-Revision": revision() });
    fill = await layerFill();
    expect(fill).toEqual(classified);
  }, 120_000);
  afterAll(async () => {
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    vi.unstubAllEnvs();
  });

  const look = async (label: string): Promise<Shot> => {
    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const result = await lookAtMap(testAccountScope(), { mapId, credential, baseUrl: `http://127.0.0.1:${port}` });
    console.info(JSON.stringify({ look: label, image: result.image.width + "x" + result.image.height, bytes: result.image.bytes, elapsedMs: result.elapsedMs,
      failures: result.composition.failures, abandoned: result.composition.abandoned }));
    if (keep) await writeFile(path.join(keep, `palette-${label}.png`), result.image.png);
    return { result, decoded: decodePng(result.image.png) };
  };

  it("draws each point in a color of its own class, none the ground's", async () => {
    const shot = await look("first");
    expect(shot.result.image).toMatchObject({ width: 1024, height: 640 });
    expect(shot.result.composition.failures).toEqual([]);
    const ground = commonest(shot.decoded, { x0: 0, y0: 0, x1: 120, y1: 120 });
    const marks = MARKS.map(([x, y]) => commonest(shot.decoded, around(x, y, 5)));
    console.info(JSON.stringify({ ground, marks }));
    for (const [index, mark] of marks.entries()) expect(apart(mark, ground), `point ${index + 1} stands out from the ground`).toBeGreaterThan(40);
    expect(apart(marks[0], marks[1]), "the first two classes differ").toBeGreaterThan(40);
    expect(apart(marks[1], marks[2]), "the last two classes differ").toBeGreaterThan(40);
    expect(apart(marks[0], marks[2]), "the outer classes differ").toBeGreaterThan(40);
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

  it("keeps the layer's colors and draws the same image once the palette is deleted", async () => {
    expect(first, "the first image's content was not established").not.toBeNull();
    expect(tolerance, "the renders' repeatability was not measured").not.toBeNull();
    await call("DELETE", `/api/palettes/${palette.name}`);
    expect((await call("GET", "/api/palettes")).custom.map((each: { name: string }) => each.name)).not.toContain(palette.name);
    if (recolor) {
      const fresh = await call("POST", `/api/layers/${layerId}/fill`, { attribute: "v", method: "quantile", classes: 3 });
      const layer = await call("GET", `/api/layers/${layerId}`);
      await call("PATCH", `/api/layers/${layerId}`, { style: { ...layer.style, fill: fresh } }, { "X-Edit-Revision": revision() });
    }
    const after = await look("deleted");
    const drift = difference(first!, after);
    console.info(JSON.stringify({ look: "deleted", comparison: drift, tolerance }));
    if (!drift.identical) {
      expect(drift.maxChannel, "the image moved past the repeatability run's tolerance per channel").toBeLessThanOrEqual(tolerance!.maxChannel);
      expect(drift.share, "the image moved on more pixels than the repeatability run's tolerance").toBeLessThanOrEqual(tolerance!.share);
    }
    expect(after.result.state.digest).toBe(first!.result.state.digest);
    expect(await layerFill(), "the layer's colors").toEqual(fill);
  }, 60_000);
});
