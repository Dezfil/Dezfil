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
import { GET as readConfig } from "@/app/api/config/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { lookAtMap, setLookDriverForTests, type LookResult } from "./map-look";
import { decodePng, encodePng, type DecodedImage } from "./png-codec";
import type { RenderDriver } from "./render-image";
import { startLoopbackBasemap } from "../../../scripts/loopback-basemap.mjs";

/**
 * The server's image of an existing map does not change when an admin
 * changes every default for new things: proved through the real render
 * road, as the map check's own real-render test proves rendering, over a
 * map whose content is established in the image before anything is
 * compared. The fixture map sits on the loopback basemap, stores no legend
 * corner, and carries an areas layer created without a style (so it drew
 * with the product's default style when it was made) and a points layer
 * created with a solid one.
 *
 * In order: the content probes on the first image (each layer's colour at
 * its mark, both legend swatches in the bottom-left corner where a map
 * storing no corner keeps its legend), so a blank or flat image can never
 * pass; a second render under the product's defaults, which sets the
 * comparison's tolerance and must itself repeat within 16 per channel on
 * at most 0.5 % of pixels, or the comparison is unmeasurable and fails
 * rather than widen; then every default changed through the change
 * operation as an admin, and the image compared with the first by its
 * bytes, or within that tolerance.
 *
 * Provisioning, as the map check's own real-render test: the port of a
 * production standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, and DEZFIL_EGRESS_ALLOWLIST
 * admitting 127.0.0.1 for the loopback basemap. One more, because a render
 * credential is signed with a key each process draws for itself while
 * here one process signs it and the other serves the page that checks it:
 * DEZFIL_RENDER_DELEGATION_KEY (64 hexadecimal digits) gives this process
 * the key, and the standalone takes the same one at start with
 * `--import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')"`.
 * Without it the page answers the sign-in redirect and every check runs
 * into its budget, so the setup refuses to start. DEZFIL_MAP_LOOK_KEEP
 * names a directory that keeps the three images.
 *
 * The two named seeds. DEZFIL_MAP_LOOK_TRANSPORT_ONLY=1, the transport
 * seed: a stub driver answering a flat image, which must fail the content
 * probes. DEZFIL_MAP_LOOK_CORNER_SEED=1, the corner seed: the map check's
 * legend fallback reads the Legend corner default for a map storing no
 * corner, as a drawing-time fallback reading its default would, which must
 * fail the image comparison once every default changed.
 */
vi.mock("@/lib/map-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/map-service")>();
  if (process.env.DEZFIL_MAP_LOOK_CORNER_SEED !== "1") return actual;
  const { instanceDefaults } = await import("@/lib/settings/defaults");
  return {
    ...actual,
    mapWithLayers: (...args: Parameters<typeof actual.mapWithLayers>) => {
      const map = actual.mapWithLayers(...args);
      return { ...map, legendCorner: map.legendCorner ?? instanceDefaults()["newMap.legendCorner"] };
    },
  };
});

const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const transportOnly = process.env.DEZFIL_MAP_LOOK_TRANSPORT_ONLY === "1";
const keep = process.env.DEZFIL_MAP_LOOK_KEEP;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
const origin = "http://instance.test";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
/** Web Mercator at 512-pixel tiles: the world is 512 * 2^zoom pixels wide. */
const WORLD = 512 * 2 ** ZOOM;
const mercatorY = (lat: number) => (WORLD / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
/** The longitude dx pixels east of the image's centre, and the latitude dy pixels below it. */
const lngAt = (dx: number) => LNG0 + (dx * 360) / WORLD;
const latAt = (dy: number) => (2 * Math.atan(Math.exp(((mercatorY(LAT0) - dy) * 2 * Math.PI) / WORLD)) - Math.PI / 2) * (180 / Math.PI);

const KELP = [26, 93, 74] as const;
/** The first colour of the product's colour cycle, which the first layer
 * of a map takes when it is created without a style. */
const TEAL = [18, 147, 154] as const;
/** The loopback basemap's tile is an opaque gray of 240. */
const GRAY = 240;
/** An areas layer's default style fills at half opacity, so its inside is
 * the cycle colour halfway to the basemap's gray. */
const AREA_DRAWN = [0, 1, 2].map((i) => Math.round((TEAL[i] + GRAY) / 2)) as unknown as readonly [number, number, number];
const solid = (c: readonly [number, number, number], radius: number) => ({ fill: { type: "constant" as const, color: { r: c[0], g: c[1], b: c[2], a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: radius, opacity: 1 });
const near = (v: number, t: number) => Math.abs(v - t) <= 16;
const isColour = (c: readonly [number, number, number]) => (r: number, g: number, b: number) => near(r, c[0]) && near(g, c[1]) && near(b, c[2]);

/** The area: 160 by 160 pixels, from 120 to 280 east of the centre. */
const AREA_SQL = "SELECT ST_GeomFromText('POLYGON ((" + [[120, -80], [280, -80], [280, 80], [120, 80], [120, -80]]
  .map(([dx, dy]) => `${lngAt(dx)} ${latAt(dy)}`).join(", ") + "))') AS geom";
const POINT_SQL = `SELECT ST_Point(${LNG0}, ${LAT0}) AS geom`;

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
/** The area's inside, 20 pixels clear of its edges: 120 by 120 pixels. */
const AREA_INSIDE: Region = { x0: 512 + 140, y0: 320 - 60, x1: 512 + 260, y1: 320 + 60 };
const BOTTOM_LEFT: Region = { x0: 0, y0: Math.floor(640 * 0.7), x1: Math.floor(1024 * 0.3), y1: 640 };

type Shot = { result: LookResult; decoded: DecodedImage };
interface Difference { identical: boolean; pixels: number; share: number; maxChannel: number }
/** How two images of the same size differ: identical bytes, or how many
 * pixels differ, what share of the image that is, and by how much at most
 * in any one channel. */
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

/** Every default an admin can change: the product's values, and none of them. */
const PRODUCT = {
  "newMap.basemap": "auto", "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": "bottom-left",
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
};
const EVERY_DEFAULT_CHANGED = {
  "newMap.basemap": "light", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
};

async function reportedDefaults(): Promise<unknown> {
  const response = await readConfig(testAccountRequest(new Request(`${origin}/api/config`)));
  expect(response.status).toBe(200);
  return (await response.json()).defaults;
}
/** The change operation as an admin; null resets a default to the product's value. */
async function changeDefaults(patch: Record<string, unknown>) {
  testAccountScope(metadataDb(), "admin");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const response = await changeInstanceSettings(testAccountRequest(new Request(`${origin}/api/instance/settings`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }), metadataDb(), "admin"));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}

describe.skipIf(!port)("the server's image of an existing map after every default changed", () => {
  let mapId: string; let area: string; let kelp: string;
  let basemap: Awaited<ReturnType<typeof startLoopbackBasemap>>;
  let heldKey: unknown; let changed = false;
  /** Set only once its content is established, and the tolerance only once it is measured within the cap. */
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
    basemap = await startLoopbackBasemap();
    expect(await reportedDefaults(), "the shared directory must start with every default at the product's value").toEqual(PRODUCT);

    const scope = testAccountScope();
    const revision = () => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });
    mapId = createMap(scope, "Made before the defaults changed").id;
    updateMap(scope, mapId, {
      viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] },
    }, revision());
    area = (await createLayer(scope, mapId, { name: "Area", sql: AREA_SQL }, revision())).id;
    kelp = (await createLayer(scope, mapId, { name: "Kelp", sql: POINT_SQL, style: solid(KELP, 10) }, revision())).id;
    expect(metadataDb().prepare("SELECT basemap, legend_corner FROM maps WHERE id = ?").get(mapId)).toEqual({ basemap: null, legend_corner: null });

    const accepted = await fetch(`http://127.0.0.1:${port}/api/maps/${mapId}`, { headers: { authorization: `Bearer ${credential()}` } });
    if (accepted.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${accepted.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    if (transportOnly) {
      const flat = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(240) });
      const consumed = JSON.stringify({ map: mapId, layers: [{ id: area, filters: [] }, { id: kelp, filters: [] }], legend: { visible: true, corner: "bottom-left", order: [area, kelp] }, widgets: [], attribution: "Loopback fixture", failures: [] });
      const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: flat, consumed }), close: async () => {}, kill: () => {} }) };
      setLookDriverForTests(driver);
    }
  }, 120_000);
  afterAll(async () => {
    setLookDriverForTests(null);
    if (changed) await changeDefaults(Object.fromEntries(Object.keys(PRODUCT).map((key) => [key, null])));
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    await basemap?.close(); vi.unstubAllEnvs();
  });

  const credential = () => delegateCredential(requireRequestAuth(authenticatedRequest()));
  const look = async (label: string): Promise<Shot> => {
    const result = await lookAtMap(testAccountScope(), { mapId, credential: credential(), baseUrl: `http://127.0.0.1:${port}` });
    console.info(JSON.stringify({ look: label, image: result.image.width + "x" + result.image.height, bytes: result.image.bytes, elapsedMs: result.elapsedMs, failures: result.composition.failures, abandoned: result.composition.abandoned }));
    if (keep) await writeFile(path.join(keep, `${label}.png`), result.image.png);
    return { result, decoded: decodePng(result.image.png) };
  };

  it("draws each layer's colour at its mark and both legend swatches bottom left, under the product's defaults", async () => {
    const shot = await look("first");
    expect(shot.result.image).toMatchObject({ width: 1024, height: 640 });
    expect(shot.result.composition.failures).toEqual([]);
    expect(count(shot.decoded, around(512, 320), isColour(KELP)), "the solid layer's mark at the centre").toBeGreaterThan(120);
    expect(count(shot.decoded, AREA_INSIDE, isColour(AREA_DRAWN)), "the areas layer's default fill across its inside").toBeGreaterThan(10_000);
    expect(count(shot.decoded, BOTTOM_LEFT, isColour(TEAL)), "the areas layer's swatch in the bottom-left corner").toBeGreaterThan(20);
    expect(count(shot.decoded, BOTTOM_LEFT, isColour(KELP)), "the solid layer's swatch in the bottom-left corner").toBeGreaterThan(20);
    expect(shot.result.state.legend).toMatchObject({ visible: true, corner: "bottom-left" });
    first = shot;
  }, 60_000);

  it("draws the same map again under the product's defaults, within 16 per channel on at most 0.5 % of pixels", async () => {
    expect(first, "the first image's content was not established").not.toBeNull();
    const repeat = difference(first!, await look("second"));
    console.info(JSON.stringify({ repeatability: repeat }));
    expect(repeat.maxChannel, "two renders of one map differ past 16 per channel: the comparison is unmeasurable").toBeLessThanOrEqual(16);
    expect(repeat.share, "two renders of one map differ on more than 0.5 % of pixels: the comparison is unmeasurable").toBeLessThanOrEqual(0.005);
    tolerance = repeat;
  }, 60_000);

  it("draws the same image after an admin changed every default", async () => {
    expect(first, "the first image's content was not established").not.toBeNull();
    expect(tolerance, "the renders' repeatability was not measured").not.toBeNull();
    changed = true;
    await changeDefaults(EVERY_DEFAULT_CHANGED);
    expect(await reportedDefaults()).toEqual(EVERY_DEFAULT_CHANGED);
    const after = await look("after");
    const drift = difference(first!, after);
    console.info(JSON.stringify({ comparison: drift, tolerance }));
    if (!drift.identical) {
      expect(drift.maxChannel, "the image moved past the repeatability run's tolerance per channel").toBeLessThanOrEqual(tolerance!.maxChannel);
      expect(drift.share, "the image moved on more pixels than the repeatability run's tolerance").toBeLessThanOrEqual(tolerance!.share);
    }
    expect(after.result.state.digest).toBe(first!.result.state.digest);
  }, 60_000);
});
