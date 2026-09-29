import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { EvaluationCancelled } from "@/lib/api/errors";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap, mapWithLayers, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { renderQueueState, type RenderBrowser, type RenderDriver } from "./render-image";
import { LOOK_IMAGE_MAX_BYTES, LOOK_SOURCE, lookAtMap, type LookResult } from "./map-look";
import { countPixels, decodePng } from "../../../scripts/png-probe.mjs";

/**
 * The bounded check's render road ('s first two cases), over an injected
 * driver and no browser: one settled render derived downwards at each
 * exact size boundary with the credit block surviving every derivation,
 * an image still above the bound at the smallest size answering no image,
 * the three deadlines each ending inside the check's own budget,
 * cancellation before and during the render, one physical render however
 * many size steps, the map's stored state untouched, the appearance in
 * the facts, and the state identity read from what the renderer consumed
 * rather than from the read that built the definition.
 */

// ---- PNG fixtures with known pixels and known byte sizes ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** The credit block: the bottom-right 12% by 8% of the image, one colour. */
const CREDIT = [200, 30, 30] as const;
const creditRegion = (w: number, h: number) => ({ x0: Math.floor(w * 0.88), y0: Math.floor(h * 0.92), x1: w, y1: h });
/** An 8-bit RGB PNG, `noise` the fraction of the width painted with
 * incompressible noise (the rest flat), the credit block in the corner,
 * padded with a text chunk to exactly `padTo` bytes when asked. */
function pngFixture(width: number, height: number, noise: number, padTo?: number): Buffer {
  let seed = 0x9e3779b9;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 24) & 0xff; };
  const rows: Buffer[] = [];
  const credit = creditRegion(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const i = 1 + x * 3;
      if (x >= credit.x0 && y >= credit.y0) { row[i] = CREDIT[0]; row[i + 1] = CREDIT[1]; row[i + 2] = CREDIT[2]; }
      else if (x < width * noise) { row[i] = rand(); row[i + 1] = rand(); row[i + 2] = rand(); }
      else { row[i] = 240; row[i + 1] = 240; row[i + 2] = 240; }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 }))];
  const end = chunk("IEND", Buffer.alloc(0));
  const bare = Buffer.concat([...parts, end]).length;
  if (padTo !== undefined) {
    const pad = padTo - bare - 12;
    if (pad < 0) throw new Error(`fixture is ${bare} bytes, past the ${padTo} asked for`);
    parts.push(chunk("tEXt", Buffer.concat([Buffer.from("pad\0", "latin1"), Buffer.alloc(pad - 4, 0x20)])));
  }
  return Buffer.concat([...parts, end]);
}
/** The share of the credit block's inner pixels that carry the credit colour; the probe's region is fractional. */
const creditPresent = (png: Buffer) => {
  const decoded = decodePng(png);
  const inner = { x0: 0.9, y0: 0.94, x1: 0.99, y1: 0.99 };
  const area = (Math.ceil(inner.x1 * decoded.width) - Math.floor(inner.x0 * decoded.width)) * (Math.ceil(inner.y1 * decoded.height) - Math.floor(inner.y0 * decoded.height));
  const hits = countPixels(decoded, ([R, G, B]: number[]) => Math.abs(R - CREDIT[0]) < 12 && Math.abs(G - CREDIT[1]) < 12 && Math.abs(B - CREDIT[2]) < 12, inner);
  return hits / area;
};

// ---- the driver ----
interface Consumed { map: string; updatedAt: string; layers: { id: string; filters: unknown }[]; legend: { visible: boolean; corner: string; order: string[] }; widgets: string[]; attribution: string }
function consumedOf(mapId: string): Consumed {
  const m = mapWithLayers(testAccountScope(), mapId);
  return { map: m.id, updatedAt: m.updatedAt, layers: m.layers.filter((l) => l.visible).map((l) => ({ id: l.id, filters: l.filters })), legend: { visible: true, corner: m.legendCorner ?? "bottom-left", order: m.layers.map((l) => l.id) }, widgets: m.widgets.filter((w) => w.visible).map((w) => w.id), attribution: "© OpenMapTiles © OpenStreetMap contributors" };
}
function driverOf(render: RenderBrowser["render"], counts = { launches: 0, renders: 0, killed: 0 }): { driver: RenderDriver; counts: typeof counts } {
  const driver: RenderDriver = { launch: async () => { counts.launches += 1; return { render: async (input) => { counts.renders += 1; return render(input); }, close: async () => {}, kill: () => { counts.killed += 1; } }; } };
  return { driver, counts };
}
const answering = (png: Buffer, mapId: string) => driverOf(async () => ({ png: new Uint8Array(png), consumed: JSON.stringify(consumedOf(mapId)) }));

let dir: string; let mapId: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-look-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  const map = createMap(testAccountScope(), "Look");
  mapId = map.id;
});
afterEach(async () => { closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const base = "http://127.0.0.1:3300";
const decodedSize = (result: LookResult) => { const d = decodePng(Buffer.from(result.image!.png)); return { width: d.width, height: d.height }; };

describe("1f and 1g: one settled render, derived downwards at each exact boundary", () => {
  it("an image exactly at the byte bound is returned at the source size, unchanged", async () => {
    const png = pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, 0.1, LOOK_IMAGE_MAX_BYTES);
    expect(png.length).toBe(LOOK_IMAGE_MAX_BYTES);
    const { driver, counts } = answering(png, mapId);
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(result.image).toMatchObject({ width: 1024, height: 640, bytes: LOOK_IMAGE_MAX_BYTES });
    expect(Buffer.from(result.image!.png).equals(png)).toBe(true);
    expect(result.source).toEqual({ width: 1024, height: 640 });
    expect(counts.renders).toBe(1);
  });
  it("one byte over the bound derives to 768 by 480 when that fits, the credit block surviving", async () => {
    const png = pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, 0.1, LOOK_IMAGE_MAX_BYTES + 1);
    const { driver, counts } = answering(png, mapId);
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(decodedSize(result)).toEqual({ width: 768, height: 480 });
    expect(result.image).toMatchObject({ width: 768, height: 480 });
    expect(result.image!.bytes).toBe(result.image!.png.byteLength);
    expect(result.image!.bytes).toBeLessThanOrEqual(LOOK_IMAGE_MAX_BYTES);
    expect(creditPresent(Buffer.from(result.image!.png))).toBeGreaterThan(0.9);
    expect(result.source).toEqual({ width: 1024, height: 640 });
    expect(counts.renders).toBe(1);
  });
  it("still over the bound at 768 derives to 512 by 320, the credit block surviving, still one render", async () => {
    const png = pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, 0.45);
    expect(png.length).toBeGreaterThan(LOOK_IMAGE_MAX_BYTES);
    const { driver, counts } = answering(png, mapId);
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(decodedSize(result)).toEqual({ width: 512, height: 320 });
    expect(result.image!.bytes).toBeLessThanOrEqual(LOOK_IMAGE_MAX_BYTES);
    expect(creditPresent(Buffer.from(result.image!.png))).toBeGreaterThan(0.9);
    expect(counts.renders).toBe(1);
    expect(counts.launches).toBe(1);
  });
  it("still over the bound at 512 by 320 answers no image and the documented outcome, one render taken", async () => {
    const png = pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, 1);
    const { driver, counts } = answering(png, mapId);
    await expect(lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver })).rejects.toMatchObject({ code: "look_image_too_large", status: 413 });
    expect(counts.renders).toBe(1);
  });
  it("the attribution the renderer used is in the facts at every size", async () => {
    for (const noise of [0.1, 0.45]) {
      const { driver } = answering(pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, noise, noise === 0.1 ? LOOK_IMAGE_MAX_BYTES + 1 : undefined), mapId);
      const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
      expect(result.attribution).toBe("© OpenMapTiles © OpenStreetMap contributors");
    }
  });
});

describe("the three deadlines end inside the check's own budget", () => {
  afterEach(() => { delete process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY; });
  const elapsed = async (run: () => Promise<unknown>) => { const t = performance.now(); await expect(run()).rejects.toMatchObject({ code: "render_timeout", status: 408 }); return performance.now() - t; };
  it("a queue wait past the budget", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = driverOf(async () => { await gate; return { png: new Uint8Array(pngFixture(64, 40, 0)), consumed: JSON.stringify(consumedOf(mapId)) }; });
    const holding = lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver: slow.driver, budgetMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(renderQueueState()).toEqual({ active: 1, waiting: 0 });
    const { driver, counts } = answering(pngFixture(64, 40, 0), mapId);
    const ms = await elapsed(() => lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, budgetMs: 150 }));
    expect(ms).toBeLessThan(1_000);
    expect(counts.launches).toBe(0);
    release();
    await holding;
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });
  it("a launch that never settles", async () => {
    const driver: RenderDriver = { launch: () => new Promise(() => {}) };
    const ms = await elapsed(() => lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, budgetMs: 150 }));
    expect(ms).toBeLessThan(1_000);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });
  it("a render that never settles, the browser killed", async () => {
    const { driver, counts } = driverOf(() => new Promise(() => {}));
    const ms = await elapsed(() => lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, budgetMs: 150 }));
    expect(ms).toBeLessThan(1_000);
    expect(counts.killed).toBeGreaterThan(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });
  it("the message names the check's budget in seconds, not the export's", async () => {
    const { driver } = driverOf(() => new Promise(() => {}));
    await expect(lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, budgetMs: 150 })).rejects.toMatchObject({ message: expect.stringMatching(/0\.15 ?s|check/) });
  });
});

describe("cancellation before and during the render", () => {
  it("before: an aborted signal launches nothing and answers the cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const { driver, counts } = answering(pngFixture(64, 40, 0), mapId);
    await expect(lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, signal: controller.signal })).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(counts.launches).toBe(0);
    expect(counts.renders).toBe(0);
  });
  it("during: the render is killed and the cancellation answered", async () => {
    const controller = new AbortController();
    const { driver, counts } = driverOf(() => new Promise(() => {}));
    const pending = lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, signal: controller.signal, budgetMs: 5_000 });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(counts.renders).toBe(1);
    expect(counts.killed).toBeGreaterThan(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("appearance in the facts, the map's stored state unchanged", () => {
  it("the headless default is light, dark is honored, and the definition handed to the renderer carries it", async () => {
    const seen: string[] = [];
    const { driver } = driverOf(async (input) => { seen.push(input.definition.appearance); return { png: new Uint8Array(pngFixture(64, 40, 0)), consumed: JSON.stringify(consumedOf(mapId)) }; });
    const light = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    const dark = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, appearance: "dark" });
    expect(light.appearance).toBe("light"); expect(light.state.appearance).toBe("light");
    expect(dark.appearance).toBe("dark"); expect(dark.state.appearance).toBe("dark");
    expect(seen).toEqual(["light", "dark"]);
  });
  it("a check writes nothing to the map", async () => {
    const before = mapWithLayers(testAccountScope(), mapId);
    const { driver } = answering(pngFixture(64, 40, 0), mapId);
    await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(mapWithLayers(testAccountScope(), mapId)).toEqual(before);
  });
  it("the render's identity is fresh per check and the source size is the documented one", async () => {
    const { driver } = answering(pngFixture(64, 40, 0), mapId);
    const a = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    const b = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/); expect(b.id).toMatch(/^[0-9a-f-]{36}$/); expect(a.id).not.toBe(b.id);
    expect(a.source).toEqual(LOOK_SOURCE);
  });
});

describe("the state identity is what the renderer consumed", () => {
  it("a render held open across a concurrent edit is attributed to the configuration the renderer drew", async () => {
    await createLayer(mapId, { name: "Before", sql: "SELECT 1 AS x, ST_Point(13.4, 52.5) AS geom" });
    const before = consumedOf(mapId);
    let consumed: Consumed | null = null;
    // The renderer's own read happens after the edit lands: the changed
    // configuration reaches the renderer, established by what it reports.
    const { driver } = driverOf(async () => {
      await createLayer(mapId, { name: "After", sql: "SELECT 2 AS x, ST_Point(13.5, 52.6) AS geom" });
      updateMap(testAccountScope(), mapId, { legendCorner: "top-right" });
      consumed = consumedOf(mapId);
      return { png: new Uint8Array(pngFixture(64, 40, 0)), consumed: JSON.stringify(consumed) };
    });
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(consumed).not.toBeNull();
    expect(consumed!.layers.map((l) => l.id)).not.toEqual(before.layers.map((l) => l.id));
    // The identity names the two layers the renderer drew and the corner it used, never the pre-
    // edit read.
    expect(result.state.layers.map((l) => l.id)).toEqual(consumed!.layers.map((l) => l.id));
    expect(result.state.legend.corner).toBe("top-right");
    expect(result.state.layers.map((l) => l.id)).not.toEqual(before.layers.map((l) => l.id));
    expect(result.state.map).toBe(mapId);
    expect(result.state.digest).toMatch(/^[0-9a-f]{16}$/);
  });
  it("the camera in the identity is the definition's, which the renderer drew, and each layer's filters are digested", async () => {
    const layer = await createLayer(mapId, { name: "Filtered", sql: "SELECT 1 AS x, ST_Point(13.4, 52.5) AS geom" });
    await createLayer(mapId, { name: "Plain", sql: "SELECT 2 AS x, ST_Point(13.5, 52.6) AS geom" });
    const seen: { lng: number; lat: number; zoom: number }[] = [];
    const { driver } = driverOf(async (input) => {
      seen.push({ lng: input.definition.viewport.lng, lat: input.definition.viewport.lat, zoom: input.definition.viewport.zoom });
      const c = consumedOf(mapId);
      c.layers = c.layers.map((l) => l.id === layer.id ? { ...l, filters: [{ kind: "range", field: "x", min: 0, max: 5 }] } : l);
      return { png: new Uint8Array(pngFixture(64, 40, 0)), consumed: JSON.stringify(c) };
    });
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(result.state.camera).toMatchObject(seen[0]);
    const filtered = result.state.layers.find((l) => l.id === layer.id)!;
    const plain = result.state.layers.find((l) => l.id !== layer.id)!;
    expect(filtered.filters).toMatch(/^[0-9a-f]{16}$/);
    expect(plain.filters).toMatch(/^[0-9a-f]{16}$/);
    expect(filtered.filters).not.toBe(plain.filters);
  });
  it("a renderer that reports nothing of what it drew is a failed render, never an identity from a later read", async () => {
    const { driver } = driverOf(async () => ({ png: new Uint8Array(pngFixture(64, 40, 0)) }));
    await expect(lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver })).rejects.toMatchObject({ code: "render_failed" });
  });
});

describe("a settled composition that shows a failure is a rendered image, reported as one", () => {
  const reporting = (extra: Partial<Consumed> & { failures?: string[] }, abandoned?: string[]) => driverOf(async () => ({ png: new Uint8Array(pngFixture(64, 40, 0)), consumed: JSON.stringify({ ...consumedOf(mapId), ...extra }), ...(abandoned ? { abandoned } : {}) }));
  it("a failed layer is in the facts", async () => {
    const { driver } = reporting({ failures: ["Parks: could not render"] });
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(result.image.width).toBe(1024);
    expect(result.composition.failures).toEqual(["Parks: could not render"]);
    expect(result.composition.abandoned).toEqual([]);
  });
  it("a failed widget is in the facts", async () => {
    const { driver } = reporting({ failures: ["Widget values failed."] });
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(result.composition.failures).toEqual(["Widget values failed."]);
  });
  it("an abandoned external request is in the facts", async () => {
    const { driver } = reporting({}, ["tiles.example.org", "tiles.example.org"]);
    const result = await lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver });
    expect(result.composition.abandoned).toEqual(["tiles.example.org", "tiles.example.org"]);
    expect(result.composition.failures).toEqual([]);
  });
});

describe("the budget covers image preparation", () => {
  it("a render answered near the deadline whose derivation runs past it is the timeout, not a late success", async () => {
    const png = pngFixture(LOOK_SOURCE.width, LOOK_SOURCE.height, 0.45);
    const { driver } = driverOf(async () => { await new Promise((r) => setTimeout(r, 90)); return { png: new Uint8Array(png), consumed: JSON.stringify(consumedOf(mapId)) }; });
    const started = performance.now();
    await expect(lookAtMap(testAccountScope(), { mapId, credential: "fixture-render-credential", baseUrl: base, driver, budgetMs: 100 })).rejects.toMatchObject({ code: "render_timeout" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
