import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createLayer } from "@/lib/layer-service";
import { mapWithLayers } from "@/lib/map-access";
import { createMap, updateMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import type { LayerStyle } from "@/lib/style/style";
import { testAccountScope } from "@/lib/test-support/accounts";
import { startLoopbackBasemap } from "../../../scripts/loopback-basemap.mjs";
import { lookDefinition } from "./map-look";
import { decodePng, type DecodedImage } from "./png-codec";

/**
 * Map labels in the server's image export, drawn by the real renderer: the
 * image endpoint of a production standalone that shares this process's data
 * directory, its own headless browser drawing the render page, the basemap a
 * loopback fixture. Every label stands alone, far from every other, so each
 * one must be drawn whole and at full strength.
 *
 * The probes, each stated from the fixture alone:
 *
 * - **A label whose middle is a gap.** "HHHH    HHHH" is symmetric, so its
 *   anchor falls between the two words in any face. The overlap test samples
 *   a label's own footprint at its anchor; drawn from the glyphs alone, that
 *   footprint has a hole there, and the label was culled with nothing near
 *   it. Its red must be drawn at full strength.
 * - **Labels as a map carries them**: three district names with their share
 *   ("Gatsibo · 21.4%"), white on a dark rim over filled polygons, a third of
 *   the image apart. Each one's white must be there, none faded.
 * - **The face.** "iiiiiiiiii" and "MMMMMMMMMM" in the same size: a
 *   monospaced face draws them the same width, the labels' own face draws
 *   the i's at well under half the M's.
 * - **Thinning still thins.** Two labels drawn over each other: the one
 *   ranked first is drawn, the other is not, so the footprint repair cannot
 *   pass by switching the overlap test off.
 * - **The footprint hides nothing.** A second map, pitched, looks at a label
 *   standing on its point with its box wholly above it, over ground a layer
 *   drawn after it fills. On a pitched map that ground lies farther away
 *   than the point, so a box writing depth would keep it from being drawn
 *   there and leave a hole of basemap. The label's own ink is transparent,
 *   so all there is to see is that ground.
 *
 * Provisioning as the map check's real-render proofs:
 * DEZFIL_MAP_LOOK_RENDER names the standalone's port; DEZFIL_DATA_DIR is the
 * directory both share; the standalone runs with DEZFIL_CHROMIUM_PATH
 * pointing at the headless shell and DEZFIL_EGRESS_ALLOWLIST admitting
 * 127.0.0.1 for the loopback basemap. Skipped without the port. The export
 * is asked with a render credential this process signs:
 * DEZFIL_RENDER_DELEGATION_KEY (64 hexadecimal digits) gives this process
 * the key, and the standalone takes the same one at start with
 * `--import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')"`.
 * A flat or blank answer fails every probe, and the polygons' own fill is
 * asserted first, so a pass is a render.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");

const LNG0 = 30.06;
const LAT0 = -1.95;
const ZOOM = 12;
/** Web Mercator at 512-pixel tiles: the world is 512 * 2^zoom pixels wide. */
const WORLD = 512 * 2 ** ZOOM;
const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
/** The ground under a pixel of the 1024 by 640 image, centred on LNG0, LAT0. */
const at = (x: number, y: number): [number, number] => {
  const lng = LNG0 + ((x - 512) * 360) / WORLD;
  const m = mercator(LAT0) - ((y - 320) * 2 * Math.PI) / WORLD;
  return [lng, (Math.atan(Math.exp(m)) * 360) / Math.PI - 90];
};

const RED = [200, 20, 20] as const;
const BLUE = [20, 20, 200] as const;
const GREEN = [20, 150, 40] as const;
const AMBER = [233, 179, 91] as const;
const rgba = (c: readonly [number, number, number], a = 1) => ({ r: c[0], g: c[1], b: c[2], a });
const near = (c: readonly [number, number, number], t = 16) => (r: number, g: number, b: number) =>
  Math.abs(r - c[0]) <= t && Math.abs(g - c[1]) <= t && Math.abs(b - c[2]) <= t;
const isWhite = near([255, 255, 255], 8);

interface Region { x0: number; y0: number; x1: number; y1: number }
const box = (x: number, y: number, halfWidth: number, halfHeight: number): Region =>
  ({ x0: x - halfWidth, y0: y - halfHeight, x1: x + halfWidth, y1: y + halfHeight });

function pixels(image: DecodedImage, region: Region, predicate: (r: number, g: number, b: number) => boolean) {
  const found: [number, number][] = [];
  for (let y = Math.max(0, region.y0); y < Math.min(image.height, region.y1); y += 1) {
    for (let x = Math.max(0, region.x0); x < Math.min(image.width, region.x1); x += 1) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) found.push([x, y]);
    }
  }
  return found;
}

/** How wide a run of ink is: its leftmost to its rightmost pixel. */
function inkWidth(found: [number, number][]): number {
  if (found.length === 0) return 0;
  const xs = found.map(([x]) => x);
  return Math.max(...xs) - Math.min(...xs) + 1;
}

/** Where the probes stand, in image pixels. */
const DISTRICTS = [
  { x: 200, y: 130, label: "Nyagatare · 25.1%", share: 25.1 },
  { x: 512, y: 130, label: "Gatsibo · 21.4%", share: 21.4 },
  { x: 824, y: 130, label: "Kayonza · 17.7%", share: 17.7 },
];
const GAP = { x: 512, y: 300, label: "HHHH    HHHH" };
const NARROW = { x: 700, y: 430, label: "iiiiiiiiii" };
const WIDE = { x: 700, y: 520, label: "MMMMMMMMMM" };
/** Ranked first, and second: the second overlaps the first's right half. */
const FIRST = { x: 260, y: 420, label: "WWWWWWWW", rank: 2 };
const SECOND = { x: 330, y: 420, label: "WWWWWWWW", rank: 1 };

/** The pitched map: its centre is the label's point, the image's centre. */
const PITCHED = { zoom: 14, pitch: 60, x: 512, y: 320 };
const PURPLE = [140, 40, 160] as const;
/** The box of an eight-letter label at 48 pixels, standing on its point: as
 * wide as its letters, a line tall, wholly above the point. */
const STANDING = { label: "OOOOOOOO", size: 48 };

const invisibleMarks = (label: LayerStyle["label"]): LayerStyle => ({
  fill: { type: "constant", color: rgba([0, 0, 0]) }, fillOpacity: 0,
  stroke: rgba([0, 0, 0]), strokeOpacity: 0, strokeWidth: 0, pointRadius: 1, opacity: 1,
  label,
});

describe.skipIf(!port)("labels in the server's image export", () => {
  let mapId: string;
  let basemap: Awaited<ReturnType<typeof startLoopbackBasemap>>;
  let heldKey: unknown;
  let image: DecodedImage;
  let pitched: DecodedImage;
  const revision = () => readDocumentRevision({ kind: "map", id: mapId })?.editRevision;
  const credential = () => delegateCredential(requireRequestAuth(authenticatedRequest()));

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
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    const stamp = Date.now().toString(36);
    const write = async (name: string, features: unknown[]) => {
      const file = path.join(dir, "fixtures", `${name}-${stamp}.geojson`);
      await writeFile(file, JSON.stringify({ type: "FeatureCollection", features }));
      return (await ingestFile(testAccountScope(), file, path.basename(file))).name;
    };
    const point = (x: number, y: number, properties: Record<string, unknown>) =>
      ({ type: "Feature", properties, geometry: { type: "Point", coordinates: at(x, y) } });
    const square = (x: number, y: number, properties: Record<string, unknown>) => {
      const ring = [at(x - 140, y - 70), at(x + 140, y - 70), at(x + 140, y + 70), at(x - 140, y + 70), at(x - 140, y - 70)];
      return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [ring] } };
    };
    const districts = await write("districts", DISTRICTS.map((d) => square(d.x, d.y, { label: d.label, share: d.share })));
    const gap = await write("gap", [point(GAP.x, GAP.y, { text: GAP.label })]);
    const faces = await write("faces", [point(NARROW.x, NARROW.y, { text: NARROW.label }), point(WIDE.x, WIDE.y, { text: WIDE.label })]);
    const crowd = await write("crowd", [FIRST, SECOND].map((c) => point(c.x, c.y, { text: c.label, rank: c.rank })));

    mapId = createMap(testAccountScope(), "Labels").id;
    updateMap(testAccountScope(), mapId, {
      viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] },
      legendCorner: "bottom-left",
    }, { expectedRevision: revision() });
    // The district style as a map carries it: white on a dark rim, the
    // largest share first, dense enough that labels keep their room.
    await createLayer(testAccountScope(), mapId, {
      name: "Districts",
      sql: `SELECT * FROM ${districts}`,
      style: {
        fill: { type: "constant", color: rgba(AMBER) }, fillOpacity: 1,
        stroke: rgba([92, 99, 112]), strokeOpacity: 0.9, strokeWidth: 1.2, pointRadius: 4, opacity: 1,
        label: { attribute: "label", size: 12, color: rgba([255, 255, 255]), haloWidth: 1, haloColor: rgba([29, 31, 36], 0.85), weight: "bold", density: 0.8, priorityField: "share" },
      },
    }, { expectedRevision: revision() });
    await createLayer(testAccountScope(), mapId, {
      name: "Gap",
      sql: `SELECT * FROM ${gap}`,
      style: invisibleMarks({ attribute: "text", size: 24, color: rgba(RED), haloWidth: 0, haloColor: rgba([0, 0, 0], 0) }),
    }, { expectedRevision: revision() });
    await createLayer(testAccountScope(), mapId, {
      name: "Faces",
      sql: `SELECT * FROM ${faces}`,
      style: invisibleMarks({ attribute: "text", size: 24, color: rgba(BLUE), haloWidth: 0, haloColor: rgba([0, 0, 0], 0) }),
    }, { expectedRevision: revision() });

    await createLayer(testAccountScope(), mapId, {
      name: "Crowd",
      sql: `SELECT * FROM ${crowd}`,
      style: invisibleMarks({ attribute: "text", size: 24, color: rgba(GREEN), haloWidth: 0, haloColor: rgba([0, 0, 0], 0), priorityField: "rank" }),
    }, { expectedRevision: revision() });

    const accepted = await fetch(`http://127.0.0.1:${port}/api/maps/${mapId}`, { headers: { authorization: `Bearer ${credential()}` } });
    if (accepted.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${accepted.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);

    // The server's image export, through its own endpoint.
    const response = await fetch(`http://127.0.0.1:${port}/api/maps/${mapId}/export/image`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential()}`, "content-type": "application/json" },
      body: JSON.stringify({ definition: lookDefinition(mapWithLayers(testAccountScope(), mapId), "light") }),
    });
    if (response.status !== 200) throw new Error(`The image export answered ${response.status}: ${await response.text()}`);
    image = decodePng(new Uint8Array(await response.arrayBuffer()));

    // The pitched map: the standing label first, the ground after it.
    const standing = await write("standing", [{ type: "Feature", properties: { text: STANDING.label }, geometry: { type: "Point", coordinates: [LNG0, LAT0] } }]);
    const ring = [[LNG0 - 0.05, LAT0], [LNG0 + 0.05, LAT0], [LNG0 + 0.05, LAT0 + 0.05], [LNG0 - 0.05, LAT0 + 0.05], [LNG0 - 0.05, LAT0]];
    const ground = await write("ground", [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }]);
    const pitchedId = createMap(testAccountScope(), "Pitched labels").id;
    const pitchedRevision = () => readDocumentRevision({ kind: "map", id: pitchedId })?.editRevision;
    updateMap(testAccountScope(), pitchedId, {
      viewport: { lng: LNG0, lat: LAT0, zoom: PITCHED.zoom, pitch: PITCHED.pitch, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] },
      legendCorner: "bottom-left",
    }, { expectedRevision: pitchedRevision() });
    await createLayer(testAccountScope(), pitchedId, {
      name: "Standing",
      sql: `SELECT * FROM ${standing}`,
      style: invisibleMarks({ attribute: "text", size: STANDING.size, color: rgba(BLUE, 0), haloWidth: 0, haloColor: rgba([0, 0, 0], 0), anchor: "top" }),
    }, { expectedRevision: pitchedRevision() });
    await createLayer(testAccountScope(), pitchedId, {
      name: "Ground",
      sql: `SELECT * FROM ${ground}`,
      style: {
        fill: { type: "constant", color: rgba(PURPLE) }, fillOpacity: 1,
        stroke: rgba(PURPLE), strokeOpacity: 0, strokeWidth: 0, pointRadius: 4, opacity: 1,
      },
    }, { expectedRevision: pitchedRevision() });
    const pitchedResponse = await fetch(`http://127.0.0.1:${port}/api/maps/${pitchedId}/export/image`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential()}`, "content-type": "application/json" },
      body: JSON.stringify({ definition: lookDefinition(mapWithLayers(testAccountScope(), pitchedId), "light") }),
    });
    if (pitchedResponse.status !== 200) throw new Error(`The image export answered ${pitchedResponse.status}: ${await pitchedResponse.text()}`);
    pitched = decodePng(new Uint8Array(await pitchedResponse.arrayBuffer()));
  }, 180_000);
  afterAll(async () => {
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    await basemap?.close();
    vi.unstubAllEnvs();
  });

  it("is a render: the documented size, the districts filled where they stand", () => {
    expect(image.width).toBe(1024);
    expect(image.height).toBe(640);
    for (const d of DISTRICTS) {
      expect(pixels(image, box(d.x, d.y + 45, 120, 15), near(AMBER)).length, d.label).toBeGreaterThan(2000);
    }
  });

  it("draws a label whose middle is a gap, whole and at full strength", () => {
    const red = pixels(image, box(GAP.x, GAP.y, 200, 30), near(RED));
    expect(red.length).toBeGreaterThan(150);
    // Both words, not one: ink either side of the anchor.
    expect(red.some(([x]) => x < GAP.x - 20)).toBe(true);
    expect(red.some(([x]) => x > GAP.x + 20)).toBe(true);
  });

  it("draws every district's label at full strength, none culled or faded", () => {
    for (const d of DISTRICTS) {
      expect(pixels(image, box(d.x, d.y, 130, 14), isWhite).length, d.label).toBeGreaterThan(60);
    }
  });

  it("still culls the second of two labels drawn over each other", () => {
    const band = box(FIRST.x, FIRST.y, 200, 20);
    const green = pixels(image, band, near(GREEN));
    // The first is drawn, and only it: its ink is centred on its own anchor,
    // where both together would centre half the anchors' distance further
    // right.
    expect(green.length).toBeGreaterThan(150);
    const xs = green.map(([x]) => x);
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - FIRST.x)).toBeLessThan(6);
  });

  it("draws a later layer's ground through an invisible label box on a pitched map", () => {
    const share = (region: Region) => {
      const area = (region.x1 - region.x0) * (region.y1 - region.y0);
      return pixels(pitched, region, near(PURPLE)).length / area;
    };
    // Beside the box the ground is drawn: a render, and the ground is there.
    expect(share({ x0: PITCHED.x + 220, y0: PITCHED.y - 40, x1: PITCHED.x + 320, y1: PITCHED.y - 8 }), "beside the box").toBeGreaterThan(0.95);
    // Behind the box, where its letters would be, the same ground.
    expect(share({ x0: PITCHED.x - 100, y0: PITCHED.y - 40, x1: PITCHED.x + 100, y1: PITCHED.y - 8 }), "behind the box").toBeGreaterThan(0.95);
  });

  it("draws labels in a proportional face: the i's well under half the M's width", () => {
    const narrow = inkWidth(pixels(image, box(NARROW.x, NARROW.y, 260, 25), near(BLUE)));
    const wide = inkWidth(pixels(image, box(WIDE.x, WIDE.y, 260, 25), near(BLUE)));
    expect(wide).toBeGreaterThan(100);
    expect(narrow).toBeGreaterThan(20);
    expect(narrow / wide).toBeLessThan(0.5);
  });
});
