import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { POST as rawlook } from "@/app/api/maps/look/route";
const look = authenticatedRoute(rawlook);
import { GET as rawreadLook } from "@/app/api/maps/look/[renderId]/route";
const readLook = authenticatedRoute(rawreadLook);
import { LookRetention, THUMBNAIL_WIDTH, lookRetention } from "./look-retention";
import { thumbnailOf } from "./look-thumbnail";
import { setLookDriverForTests, type LookResult } from "./map-look";
import { decodePng, encodePng, pngDimensions } from "./png-codec";
import type { RenderDriver } from "./render-image";

/**
 * Retention and the retained-image read (the read half of 6c): full
 * images and thumbnails counted together under a count bound and a byte
 * bound, each evicting oldest first on its own; an evicted render and a
 * pre-restart render answering the documented unavailability with no
 * render dispatched; the read answering exactly the retained bytes as
 * an attachment, the thumbnail derived once with the check and kept as
 * it arrived.
 */
const png = (w: number, h: number, v: number) => encodePng({ width: w, height: h, rgba: new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (v * 37 + (i >> 2) * 7) & 0xff)) });
let n = 0;
function resultOf(bytes: Uint8Array, width = 1024, height = 640): LookResult {
  n += 1;
  return {
    id: `render-${n}`, mapId: "m", mapName: "M", appearance: "light",
    state: { map: "m", camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], appearance: "light", digest: "0000000000000000" },
    image: { width, height, bytes: bytes.byteLength, png: bytes }, thumbnail: thumbnailOf({ width, height, png: bytes }), source: { width: 1024, height: 640 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1,
  };
}

describe("the two bounds evict independently, oldest first", () => {
  it("the count bound: the fourth render evicts the first, the thumbnail counted with the image", () => {
    const store = new LookRetention({ count: 3, bytes: 64 * 1024 * 1024 });
    const first = store.retain(resultOf(png(64, 40, 1)));
    store.retain(resultOf(png(64, 40, 2)));
    store.retain(resultOf(png(64, 40, 3)));
    expect(store.size().count).toBe(3);
    expect(store.read(first.id, "full")).not.toBeNull();
    const fourth = store.retain(resultOf(png(64, 40, 4)));
    expect(store.size().count).toBe(3);
    expect(store.read(first.id, "full")).toBeNull();
    expect(store.read(first.id, "thumbnail")).toBeNull();
    expect(store.read(fourth.id, "full")).not.toBeNull();
    expect(store.ids()).not.toContain(first.id);
    expect(store.size().bytes).toBe(store.ids().reduce((sum, id) => sum + store.read(id, "full")!.byteLength + store.read(id, "thumbnail")!.byteLength, 0));
  });
  it("the byte bound: retaining past it evicts the oldest until the total fits, the count bound untouched", () => {
    const big = png(256, 160, 5);
    const thumb = new LookRetention({ count: 100, bytes: 1 }).retain(resultOf(big));
    const perRender = big.byteLength + thumb.thumbnailBytes;
    const store = new LookRetention({ count: 100, bytes: perRender * 2 + 10 });
    // The same pattern three times: identical byte sizes, distinct identities.
    const a = store.retain(resultOf(png(256, 160, 5)));
    const b = store.retain(resultOf(png(256, 160, 5)));
    expect(store.size()).toEqual({ count: 2, bytes: perRender * 2 });
    const c = store.retain(resultOf(png(256, 160, 5)));
    expect(store.ids()).toEqual([b.id, c.id]);
    expect(store.read(a.id, "full")).toBeNull();
    expect(store.size().bytes).toBeLessThanOrEqual(perRender * 2 + 10);
  });
  it("the thumbnail is derived once with the check and kept at retention, at the documented width and the image's aspect", () => {
    const store = new LookRetention({ count: 4, bytes: 64 * 1024 * 1024 });
    const kept = store.retain(resultOf(png(1024, 640, 8)));
    const thumbnail = store.read(kept.id, "thumbnail")!;
    expect(pngDimensions(thumbnail)).toEqual({ width: THUMBNAIL_WIDTH, height: Math.round((THUMBNAIL_WIDTH * 640) / 1024) });
    expect(decodePng(thumbnail).width).toBe(THUMBNAIL_WIDTH);
    const smaller = store.retain(resultOf(png(512, 320, 9), 512, 320));
    expect(pngDimensions(store.read(smaller.id, "thumbnail")!)).toEqual({ width: THUMBNAIL_WIDTH, height: Math.round((THUMBNAIL_WIDTH * 320) / 512) });
    expect(Buffer.from(store.read(kept.id, "full")!).equals(Buffer.from(png(1024, 640, 8)))).toBe(true);
  });
});

describe("6b and 6c: the read route", () => {
  let dir: string; let mapId: string;
  const counts = { launches: 0 };
  const FIXTURE = png(1024, 640, 11);
  beforeEach(async () => {
    await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-retention-"));
    vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3300");
    closeMetadataDb(); lookRetention.resetForTests(); counts.launches = 0;
    mapId = createMap("Retained").id;
    const driver: RenderDriver = { launch: async () => { counts.launches += 1; return { render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }; } };
    setLookDriverForTests(driver);
  });
  afterEach(async () => { setLookDriverForTests(null); lookRetention.resetForTests(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  const params = (renderId: string) => ({ params: Promise.resolve({ renderId }) });
  const read = (id: string, variant?: string) => readLook(new Request(`http://127.0.0.1:3300/api/maps/look/${id}${variant ? `?variant=${variant}` : ""}`), params(id));

  it("the check retains its render; the read answers exactly the retained bytes as an attachment and dispatches no render", async () => {
    const answered = await (await look(new Request("http://127.0.0.1:3300/api/maps/look", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapId }) }))).json() as { render: { id: string } };
    expect(counts.launches).toBe(1);
    const full = await read(answered.render.id);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    expect(full.headers.get("content-disposition")).toContain("attachment");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await full.arrayBuffer()).equals(Buffer.from(FIXTURE))).toBe(true);
    const thumbnail = await read(answered.render.id, "thumbnail");
    expect(thumbnail.status).toBe(200);
    expect(pngDimensions(new Uint8Array(await thumbnail.arrayBuffer())).width).toBe(THUMBNAIL_WIDTH);
    expect(counts.launches).toBe(1);
    const bad = await read(answered.render.id, "huge");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
  it("an evicted render and a pre-restart render answer the documented unavailability, with no render dispatched", async () => {
    const answered = await (await look(new Request("http://127.0.0.1:3300/api/maps/look", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapId }) }))).json() as { render: { id: string } };
    lookRetention.evictForTests(answered.render.id);
    const evicted = await read(answered.render.id);
    expect(evicted.status).toBe(404);
    expect(await evicted.json()).toMatchObject({ error: { code: "look_image_unavailable" } });
    // A restart: the process's working state is gone with it.
    lookRetention.resetForTests();
    const gone = await read(answered.render.id, "thumbnail");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "look_image_unavailable" } });
    expect(counts.launches).toBe(1);
  });
});

describe("an entry that cannot fit by itself is not kept", () => {
  it("under a byte cap smaller than one image the store stays at zero and the read is unavailable", () => {
    const image = png(256, 160, 5);
    const store = new LookRetention({ count: 100, bytes: image.byteLength - 1 });
    const kept = store.retain(resultOf(image));
    expect(store.size()).toEqual({ count: 0, bytes: 0 });
    expect(store.read(kept.id, "full")).toBeNull();
  });
});
