import { testAccountScope } from "@/lib/test-support/accounts";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { lookAtMap, setLookDriverForTests, type LookResult } from "./map-look";
import { decodePng, encodePng, type DecodedImage } from "./png-codec";
import type { RenderDriver } from "./render-image";
import { startLoopbackBasemap } from "../../../scripts/loopback-basemap.mjs";
import type { LayerFilter } from "@/lib/viz";

/**
 * The positive proof of rendering: the bounded check through the real
 * render road against a production standalone that shares this process's
 * data directory, the basemap a loopback fixture, the answered image
 * decoded at the documented dimensions, and each constituent established
 * separately against an expectation stated from the seed alone, with a
 * pixel probe wherever the claim is about pixels: the camera (a mark at
 * the centre when the stored view is centred on it, and 200 pixels east
 * when the stored view is moved west by the longitude that Web Mercator
 * maps to 200 pixels at the stored zoom), which layers are visible (the
 * hidden layer's colour absent), the stored filters in force (the
 * excluded point's colour absent where the point would be), the legend
 * (its swatches in the legend corner) and the widgets (the rail's ink in
 * its corner, gone when the widget is hidden).
 *
 * Provisioning: DEZFIL_MAP_LOOK_RENDER names the standalone's port;
 * DEZFIL_DATA_DIR is the directory both share; DEZFIL_CHROMIUM_PATH
 * points at Playwright's headless shell; DEZFIL_EGRESS_ALLOWLIST admits
 * 127.0.0.1 for the loopback basemap. Skipped without the port.
 * DEZFIL_MAP_LOOK_TRANSPORT_ONLY=1 is the named seed: a stub driver
 * answering a flat image, which must fail here, so a transport pass is
 * distinguishable from a render.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const transportOnly = process.env.DEZFIL_MAP_LOOK_TRANSPORT_ONLY === "1";

const ZOOM = 12;
const LNG0 = 13.4; const LAT0 = 52.5;
/** Web Mercator at 512-pixel tiles: the world is 512 * 2^zoom pixels wide. */
const WORLD = 512 * 2 ** ZOOM;
const DLNG_200PX = (200 * 360) / WORLD;
/** The latitude step that Web Mercator maps to about 120 pixels at LAT0. */
const DLAT_120PX = ((120 * 2 * Math.PI) / WORLD) * Math.cos((LAT0 * Math.PI) / 180) * (180 / Math.PI);
const KELP = [26, 93, 74] as const;
const AMBER = [233, 179, 91] as const;
const BLUE = [40, 80, 220] as const;
const rgba = (c: readonly [number, number, number]) => ({ r: c[0], g: c[1], b: c[2], a: 1 });
const solid = (c: readonly [number, number, number], radius: number) => ({ fill: { type: "constant" as const, color: rgba(c) }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: radius, opacity: 1 });
const near = (v: number, t: number) => Math.abs(v - t) <= 16;
const isColour = (c: readonly [number, number, number]) => (r: number, g: number, b: number) => near(r, c[0]) && near(g, c[1]) && near(b, c[2]);
const isInk = (r: number, g: number, b: number) => r < 110 && g < 110 && b < 110;

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
const whole = (image: DecodedImage): Region => ({ x0: 0, y0: 0, x1: image.width, y1: image.height });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

describe.skipIf(!port)("the real bounded check renders the map", () => {
  let mapId: string; let kelp: string; let amber: string; let blue: string;
  let basemap: Awaited<ReturnType<typeof startLoopbackBasemap>>;
  const FILTER: LayerFilter[] = [{ kind: "range", field: "v", min: null, max: 1 }];
  const looks: LookResult[] = [];

  beforeAll(async () => {
    const dir = process.env.DEZFIL_DATA_DIR;
    if (!dir) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();
    basemap = await startLoopbackBasemap();
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    const file = path.join(dir, "fixtures", `look-${Date.now().toString(36)}.geojson`);
    const feature = (lng: number, lat: number, properties: Record<string, unknown>) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lng, lat] } });
    await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [
      feature(LNG0, LAT0, { kind: "a", v: 0 }),
      feature(LNG0 + 0.01, LAT0, { kind: "b", v: 0 }),
      feature(LNG0, LAT0 + DLAT_120PX, { kind: "c", v: 1 }),
      feature(LNG0, LAT0 - DLAT_120PX, { kind: "c", v: 2 }),
    ] }));
    const table = await ingestFile(testAccountScope(), file, path.basename(file));
    mapId = createMap(testAccountScope(), "Real look").id;
    updateMap(testAccountScope(), mapId, {
      viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] },
      legendCorner: "bottom-left",
    });
    kelp = (await createLayer(testAccountScope(), mapId, { name: "Kelp", sql: `SELECT * FROM ${table.name} WHERE kind = 'a'`, style: solid(KELP, 10) })).id;
    amber = (await createLayer(testAccountScope(), mapId, { name: "Amber", sql: `SELECT * FROM ${table.name} WHERE kind = 'b'`, style: solid(AMBER, 10) })).id;
    blue = (await createLayer(testAccountScope(), mapId, { name: "Blue", sql: `SELECT * FROM ${table.name} WHERE kind = 'c'`, style: solid(BLUE, 10) })).id;
    await updateLayer(testAccountScope(), amber, { visible: false });
    await updateLayer(testAccountScope(), blue, { filters: FILTER });
    updateMap(testAccountScope(), mapId, { widgets: [{ id: "w-count", type: "formula", layerId: kelp, title: "Points", field: null, agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] });
    if (transportOnly) {
      const flat = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(240) });
      const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: flat, consumed: JSON.stringify({ map: mapId, layers: [{ id: kelp, filters: [] }, { id: blue, filters: FILTER }], legend: { visible: true, corner: "bottom-left", order: [kelp, blue] }, widgets: ["w-count"], attribution: "Loopback fixture", failures: [] }) }), close: async () => {}, kill: () => {} }) };
      setLookDriverForTests(driver);
    }
  }, 120_000);
  afterAll(async () => { setLookDriverForTests(null); await basemap?.close(); vi.unstubAllEnvs(); });

  const look = async () => {
    const result = await lookAtMap(testAccountScope(), { mapId, credential: delegateCredential(requireRequestAuth(authenticatedRequest())), baseUrl: `http://127.0.0.1:${port}` });
    looks.push(result);
    console.info(JSON.stringify({ look: result.id, image: result.image.width + "x" + result.image.height, bytes: result.image.bytes, elapsedMs: result.elapsedMs, failures: result.composition.failures, abandoned: result.composition.abandoned }));
    return { result, decoded: decodePng(result.image.png) };
  };

  it("answers an image decoded at the documented dimensions, with the facts of a settled composition", async () => {
    const { result, decoded } = await look();
    expect(result.image).toMatchObject({ width: 1024, height: 640 });
    expect(decoded.width).toBe(1024); expect(decoded.height).toBe(640);
    expect(result.image.bytes).toBe(result.image.png.byteLength);
    expect(result.composition.failures).toEqual([]);
    expect(result.attribution).toContain("Loopback fixture");
    expect(result.elapsedMs).toBeLessThan(30_000);
  }, 60_000);

  it("the camera: the centred mark at the centre, and 200 pixels east once the stored view moves west", async () => {
    const { decoded } = await look();
    expect(count(decoded, around(512, 320), isColour(KELP))).toBeGreaterThan(120);
    updateMap(testAccountScope(), mapId, { viewport: { lng: LNG0 - DLNG_200PX, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 } });
    try {
      const moved = await look();
      expect(moved.result.state.camera.lng).toBeCloseTo(LNG0 - DLNG_200PX, 6);
      expect(count(moved.decoded, around(712, 320), isColour(KELP))).toBeGreaterThan(120);
      expect(count(moved.decoded, around(512, 320), isColour(KELP))).toBe(0);
    } finally {
      updateMap(testAccountScope(), mapId, { viewport: { lng: LNG0, lat: LAT0, zoom: ZOOM, pitch: 0, bearing: 0 } });
    }
  }, 120_000);

  it("visibility: the hidden layer's colour is nowhere, and the identity names only the visible layers", async () => {
    const { result, decoded } = await look();
    expect(count(decoded, whole(decoded), isColour(AMBER))).toBe(0);
    expect(result.state.layers.map((l) => l.id).sort()).toEqual([kelp, blue].sort());
  }, 60_000);

  it("the stored filters in force: the kept point drawn, the excluded point absent, the digest of the stored filter in the identity", async () => {
    const { result, decoded } = await look();
    expect(count(decoded, around(512, 200), isColour(BLUE))).toBeGreaterThan(120);
    expect(count(decoded, around(512, 440), isColour(BLUE))).toBe(0);
    expect(result.state.layers.find((l) => l.id === blue)?.filters).toBe(digest(FILTER));
    expect(result.state.layers.find((l) => l.id === kelp)?.filters).toBe(digest([]));
  }, 60_000);

  it("the legend: both visible layers' swatches in the legend corner, in the identity's order", async () => {
    const { result, decoded } = await look();
    const corner: Region = { x0: 0, y0: Math.floor(640 * 0.7), x1: Math.floor(1024 * 0.3), y1: 640 };
    expect(count(decoded, corner, isColour(KELP))).toBeGreaterThan(20);
    expect(count(decoded, corner, isColour(BLUE))).toBeGreaterThan(20);
    expect(result.state.legend).toMatchObject({ visible: true, corner: "bottom-left" });
    expect(result.state.legend.order.sort()).toEqual([kelp, blue].sort());
  }, 60_000);

  it("the widgets: the rail's ink in its corner while the widget is visible, gone when it is hidden, the identity saying which", async () => {
    const { result, decoded } = await look();
    const corner: Region = { x0: Math.floor(1024 * 0.7), y0: 0, x1: 1024, y1: Math.floor(640 * 0.3) };
    const shown = count(decoded, corner, isInk);
    expect(shown).toBeGreaterThan(50);
    expect(result.state.widgets).toEqual(["w-count"]);
    updateMap(testAccountScope(), mapId, { widgets: [{ id: "w-count", type: "formula", layerId: kelp, title: "Points", field: null, agg: "count", aggField: null, unit: null, note: null, format: null, visible: false }] });
    const hidden = await look();
    expect(hidden.result.state.widgets).toEqual([]);
    expect(count(hidden.decoded, corner, isInk)).toBeLessThan(shown / 4);
  }, 120_000);
});
