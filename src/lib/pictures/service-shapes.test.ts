import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it, vi } from "vitest";

/** The renderer stand-in answers each shape exactly as asked: a master of
 * the definition's size and every kept size in its format, under a
 * complete declaration; every call is recorded. */
const calls = vi.hoisted(() => [] as { appearance: string; size: { width: number; height: number }; mapScale?: number; sizes: { width: number; type: string }[]; padding: unknown }[]);
const encoding = vi.hoisted(() => ({ failWide: false }));
vi.mock("@/lib/export/render-image", async () => {
  const { captureBasemap } = await import("@/lib/thumbnail-evidence");
  const header = (width: number, height: number) => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    return new Uint8Array(bytes);
  };
  const webp = (width: number, height: number) => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBP", 8, "latin1"); bytes.write("VP8X", 12, "latin1");
    bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
    return new Uint8Array(bytes);
  };
  return {
    renderMapImage: async (_scope: unknown, input: { mapId: string; definition: { appearance: "light" | "dark"; size: { width: number; height: number }; mapScale?: number }; picture: { frame: { padding: unknown }; sizes: { width: number; height: number; type: string }[] }; admitted?: () => void }) => {
      input.admitted?.();
      // The wide master is the one 3312 pixels wide.
      if (encoding.failWide && input.picture.sizes.some(s => s.width === 3312)) throw new Error("The picture could not be encoded: the browser answered image/png.");
      calls.push({ appearance: input.definition.appearance, size: input.definition.size, mapScale: input.definition.mapScale, sizes: input.picture.sizes.map((s) => ({ width: s.width, type: s.type })), padding: input.picture.frame.padding });
      const style = captureBasemap(input.mapId, input.definition.appearance)!.url;
      return {
        png: header(input.definition.size.width, input.definition.size.height),
        abandoned: [],
        consumed: JSON.stringify({ map: input.mapId, layers: [], failures: [], unsupported: [], paintedStyle: style, requestedStyle: style }),
        encoded: input.picture.sizes.map((s) => (s.type === "image/png" ? header(s.width, s.height) : webp(s.width, s.height))),
      };
    },
  };
});

import { createMap } from "@/lib/map-service";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { publishedPictureSized, readPicture } from "@/lib/map-thumbnails";
import { PictureService } from "./service";
import { getPictureState } from "./state";
import { pictureTarget } from "./publication";
import { PICTURE_SHAPES } from "./shapes";

isolatePictureData();
afterAll(closeMetadataDb);

it("renders both shapes of each appearance, framed by their own margins, and publishes every kept size", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Shapes");
  let now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now });
  await service.request(map.id); now += 5000; service.queue.tick(); await service.queue.drain();
  expect(getPictureState(map.id)).toMatchObject({ state: "current" });
  const card = PICTURE_SHAPES.card, wide = PICTURE_SHAPES.wide;
  const shapeOf = (size: { width: number }) => (size.width === card.frame.width * card.scale ? "card" : "wide");
  expect(calls.map((c) => [c.appearance, shapeOf(c.size)])).toEqual([["light", "card"], ["light", "wide"], ["dark", "card"], ["dark", "wide"]]);
  for (const call of calls) {
    const spec = shapeOf(call.size) === "card" ? card : wide;
    expect(call.mapScale).toBe(spec.scale);
    expect(call.padding).toEqual(spec.padding);
    expect(call.sizes.filter((s) => s.type === "image/webp").map((s) => s.width)).toEqual(spec.widths);
  }
  expect(await publishedPictureSized(map.id)).toBe(true);
  expect((await readPicture(scope, map.id, "dark", { shape: "wide", width: 2000 }))?.type).toBe("image/webp");
  expect((await readPicture(scope, map.id, "light"))?.type).toBe("image/png");
});

it("renders a pending retry still on the digest's first formula at its own generation", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Retry across the formula");
  let now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now });
  const target = pictureTarget(scope, map.id);
  // The request marks the renderer ready; the row then stands as the earlier
  // code left it, so only the attempt's own check can move it.
  const state = await service.request(map.id);
  metadataDb().prepare("UPDATE map_pictures SET digest = ?, attempt_count = 1, next_attempt_at = ? WHERE map_id = ?").run(target.firstFormulaDigest, now, map.id);
  const before = calls.length;
  now += 1; service.queue.tick(); await service.queue.drain();
  expect(calls.length).toBe(before + 4);
  expect(getPictureState(map.id)).toMatchObject({ state: "current", digest: target.digest, requestedGeneration: state.requestedGeneration, publishedGeneration: state.requestedGeneration });
});

it("publishes nothing when one shape's sizes cannot be encoded, and keeps the previous picture", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Encoding fails");
  let now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now });
  await service.request(map.id); now += 5000; service.queue.tick(); await service.queue.drain();
  const previous = getPictureState(map.id)!;
  const served = (await readPicture(scope, map.id, "light", { shape: "card", width: 720 }))?.bytes;
  expect(previous.state).toBe("current");
  encoding.failWide = true;
  try {
    await service.refresh(map.id); now += 5000; service.queue.tick(); await service.queue.drain();
  } finally { encoding.failWide = false; }
  expect(getPictureState(map.id)).toMatchObject({ state: "failed", publishedGeneration: previous.publishedGeneration });
  expect((await readPicture(scope, map.id, "light", { shape: "card", width: 720 }))?.bytes).toEqual(served);
});
