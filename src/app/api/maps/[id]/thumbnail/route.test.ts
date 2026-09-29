import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap, removeMap } from "@/lib/map-service";
import { readThumbnail } from "@/lib/map-thumbnails";
import { GET, PUT } from "./route";
import { POST as duplicate } from "../duplicate/route";

/**
 * The thumbnail route by theme: a themed write is held until its cycle
 * completes; a read naming a theme the map has no image for is answered
 * with one it has; a map with no image is refused as it always was; a
 * read naming no theme answers as it did.
 */

let dir: string;
let mapId: string;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (tag: string) =>
  new Uint8Array([...PNG_MAGIC, ...Buffer.from(tag)]) as Uint8Array<ArrayBuffer>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  mapId = createMap(testAccountScope(), "m").id;
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function put(query: string, body: Uint8Array<ArrayBuffer>, id = mapId) {
  return PUT(
    new Request(`http://test/api/maps/${id}/thumbnail${query}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body,
    }),
    params(id),
  );
}

async function get(query: string, id = mapId) {
  const response = await GET(
    new Request(`http://test/api/maps/${id}/thumbnail${query}`),
    params(id),
  );
  const tag =
    response.status === 200
      ? Buffer.from(await response.arrayBuffer()).subarray(8).toString()
      : null;
  return { status: response.status, tag };
}

describe("PUT and GET /api/maps/{id}/thumbnail by theme", () => {
  it("a write naming no theme stores the map's one image, and a themed read falls back to it", async () => {
    expect((await put("", png("single"))).status).toBe(204);
    expect(await get("")).toEqual({ status: 200, tag: "single" });
    expect(await get("?theme=light")).toEqual({ status: 200, tag: "single" });
    expect(await get("?theme=dark")).toEqual({ status: 200, tag: "single" });
  });

  it("a map with no image is refused for every read, theme or none", async () => {
    expect((await get("")).status).toBe(404);
    expect((await get("?theme=dark")).status).toBe(404);
  });

  it("a themed write is held (202) until its partner completes the cycle (204)", async () => {
    expect((await put("?theme=light&cycle=c1", png("L"))).status).toBe(202);
    // Held, not published: the map still has no image.
    expect((await get("?theme=light")).status).toBe(404);
    expect((await put("?theme=dark&cycle=c1", png("D"))).status).toBe(204);
    expect(await get("?theme=light")).toEqual({ status: 200, tag: "L" });
    expect(await get("?theme=dark")).toEqual({ status: 200, tag: "D" });
    expect(await get("")).toEqual({ status: 200, tag: "L" });
  });

  it("a half-finished cycle leaves what the map had", async () => {
    await put("", png("single"));
    expect((await put("?theme=dark&cycle=c2", png("D"))).status).toBe(202);
    expect(await get("?theme=dark")).toEqual({ status: 200, tag: "single" });
    expect(await get("")).toEqual({ status: 200, tag: "single" });
  });

  it("refuses an unknown theme, a themed write without a cycle, a cycle without a theme, and a malformed cycle", async () => {
    expect((await get("?theme=blue")).status).toBe(400);
    expect((await put("?theme=light", png("L"))).status).toBe(400);
    expect((await put("?cycle=c1", png("L"))).status).toBe(400);
    expect((await put("?theme=light&cycle=../x", png("L"))).status).toBe(400);
    expect((await put("?theme=blue&cycle=c1", png("L"))).status).toBe(400);
    // Nothing of that landed.
    expect((await get("")).status).toBe(404);
  });

  it("still refuses a body that is not a PNG under a theme", async () => {
    expect(
      (await put("?theme=light&cycle=c1", new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>)).status,
    ).toBe(400);
  });

  it("duplicating carries a themed pair; deleting the source leaves none", async () => {
    await put("?theme=light&cycle=c1", png("L"));
    await put("?theme=dark&cycle=c1", png("D"));
    const copy = (await (
      await duplicate(testAccountRequest(new Request("http://test")), params(mapId))
    ).json()) as { id: string };
    expect(await get("?theme=light", copy.id)).toEqual({ status: 200, tag: "L" });
    expect(await get("?theme=dark", copy.id)).toEqual({ status: 200, tag: "D" });
    await removeMap(mapId);
    // The source's files are gone, theme by theme; the copy keeps its own.
    expect(await readThumbnail(mapId, "light")).toBeNull();
    expect(await readThumbnail(mapId, "dark")).toBeNull();
    expect(await readThumbnail(mapId)).toBeNull();
    expect(await get("?theme=dark", copy.id)).toEqual({ status: 200, tag: "D" });
  });

  it("duplicating carries a single image; deleting the source leaves none", async () => {
    await put("", png("single"));
    const copy = (await (
      await duplicate(testAccountRequest(new Request("http://test")), params(mapId))
    ).json()) as { id: string };
    expect(await get("", copy.id)).toEqual({ status: 200, tag: "single" });
    expect(await get("?theme=dark", copy.id)).toEqual({ status: 200, tag: "single" });
    await removeMap(copy.id);
    expect(await readThumbnail(copy.id)).toBeNull();
    expect(await readThumbnail(copy.id, "light")).toBeNull();
    expect(await get("", mapId)).toEqual({ status: 200, tag: "single" });
  });
});
