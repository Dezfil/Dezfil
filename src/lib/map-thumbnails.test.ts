import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { insertMap } from "@/lib/metadata/maps";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  copyThumbnail,
  readThumbnail,
  removeThumbnail,
  saveThemedThumbnail,
  saveThumbnail,
  thumbnailManifestPath,
  thumbnailPath,
  thumbnailSetFile,
} from "./map-thumbnails";

/**
 * Map card images by theme. A map is single or themed, never mixed; a
 * themed write is held until its partner arrives under the same cycle,
 * and only the completed pair replaces what the map had.
 */

let dir: string;

const S = Buffer.from("single-image");
const L = Buffer.from("light-image");
const D = Buffer.from("dark-image");

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  const scope = testAccountScope();
  const template = createMap(scope, "Thumbnail fixture");
  for (const id of ["m1","m2","m3","m4","m5","m6","m7","a1","a2","b1","b2","z1","z2","w1","x1"]) insertMap(scope, { ...template, id });
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** Every file the thumbnails directory holds, recursively, relative. */
async function files(): Promise<string[]> {
  const root = path.join(dir, "data", "thumbnails");
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full));
    }
  };
  await walk(root);
  return out.sort();
}

const text = (b: Buffer | null) => (b ? b.toString() : null);

describe("map thumbnails by theme", () => {
  it("a single write is the map's one image and answers every read", async () => {
    await saveThumbnail(testAccountScope(), "m1", S);
    expect(text(await readThumbnail(testAccountScope(), "m1"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "m1", "light"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "m1", "dark"))).toBe("single-image");
    expect(await files()).toEqual(["m1.png"]);
  });

  it("a themed write is held until its partner arrives under the same cycle", async () => {
    expect(await saveThemedThumbnail(testAccountScope(), "m2", "light", "c1", L)).toBe("held");
    // Nothing is published yet: the map has no image and is refused.
    expect(await readThumbnail(testAccountScope(), "m2", "light")).toBeNull();
    expect(await readThumbnail(testAccountScope(), "m2")).toBeNull();
    expect(await saveThemedThumbnail(testAccountScope(), "m2", "dark", "c1", D)).toBe("published");
    expect(text(await readThumbnail(testAccountScope(), "m2", "light"))).toBe("light-image");
    expect(text(await readThumbnail(testAccountScope(), "m2", "dark"))).toBe("dark-image");
    // A read naming no theme answers with an image the map has.
    expect(text(await readThumbnail(testAccountScope(), "m2"))).toBe("light-image");
    expect(await files()).toEqual(["m2.c1.dark.png", "m2.c1.light.png", "m2.json"]);
  });

  it("a half-finished cycle leaves the previous set alone; the completed one replaces it", async () => {
    await saveThumbnail(testAccountScope(), "m3", S);
    expect(await saveThemedThumbnail(testAccountScope(), "m3", "light", "c2", L)).toBe("held");
    expect(text(await readThumbnail(testAccountScope(), "m3", "light"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "m3", "dark"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "m3"))).toBe("single-image");
    expect(await saveThemedThumbnail(testAccountScope(), "m3", "dark", "c2", D)).toBe("published");
    expect(text(await readThumbnail(testAccountScope(), "m3", "light"))).toBe("light-image");
    expect(text(await readThumbnail(testAccountScope(), "m3", "dark"))).toBe("dark-image");
    expect(text(await readThumbnail(testAccountScope(), "m3"))).toBe("light-image");
    // The single file is gone with the pair in place, and nothing is held.
    expect(await files()).toEqual(["m3.c2.dark.png", "m3.c2.light.png", "m3.json"]);
  });

  it("writes from different cycles never pair, and a publish discards every other pending write", async () => {
    await saveThemedThumbnail(testAccountScope(), "m4", "light", "c1", Buffer.from("light-1"));
    await saveThemedThumbnail(testAccountScope(), "m4", "dark", "c1", Buffer.from("dark-1"));
    expect(await saveThemedThumbnail(testAccountScope(), "m4", "light", "c3", Buffer.from("light-3"))).toBe("held");
    // A dark write under another cycle does not complete c3's light.
    expect(await saveThemedThumbnail(testAccountScope(), "m4", "dark", "c4", Buffer.from("dark-4"))).toBe("held");
    expect(text(await readThumbnail(testAccountScope(), "m4", "light"))).toBe("light-1");
    expect(text(await readThumbnail(testAccountScope(), "m4", "dark"))).toBe("dark-1");
    expect(await saveThemedThumbnail(testAccountScope(), "m4", "light", "c4", Buffer.from("light-4"))).toBe("published");
    expect(text(await readThumbnail(testAccountScope(), "m4", "light"))).toBe("light-4");
    expect(text(await readThumbnail(testAccountScope(), "m4", "dark"))).toBe("dark-4");
    expect(await files()).toEqual(["m4.c4.dark.png", "m4.c4.light.png", "m4.json"]);
  });

  it("a single write after a themed pair returns the map to one image", async () => {
    await saveThemedThumbnail(testAccountScope(), "m5", "light", "c1", L);
    await saveThemedThumbnail(testAccountScope(), "m5", "dark", "c1", D);
    await saveThemedThumbnail(testAccountScope(), "m5", "light", "c9", Buffer.from("stale-pending"));
    await saveThumbnail(testAccountScope(), "m5", S);
    expect(text(await readThumbnail(testAccountScope(), "m5", "dark"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "m5", "light"))).toBe("single-image");
    expect(await files()).toEqual(["m5.png"]);
  });

  it("a read for a theme the map has no image for answers with what it has", async () => {
    // A manifest whose light file is missing (a partially restored set).
    await mkdir(path.dirname(thumbnailPath("m6")), { recursive: true });
    const dark = thumbnailSetFile("m6", "c1", "dark");
    await writeFile(path.join(path.dirname(thumbnailPath("m6")), dark), D);
    await writeFile(
      thumbnailManifestPath("m6"),
      JSON.stringify({ light: thumbnailSetFile("m6", "c1", "light"), dark }),
    );
    expect(text(await readThumbnail(testAccountScope(), "m6", "light"))).toBe("dark-image");
    expect(text(await readThumbnail(testAccountScope(), "m6"))).toBe("dark-image");
    // The set's own file wins over the single one for its theme; the
    // missing light falls back to the single.
    await writeFile(thumbnailPath("m6"), S);
    expect(text(await readThumbnail(testAccountScope(), "m6", "dark"))).toBe("dark-image");
    expect(text(await readThumbnail(testAccountScope(), "m6", "light"))).toBe("single-image");
  });

  it("a map with no image is refused for every read", async () => {
    expect(await readThumbnail(testAccountScope(), "m7")).toBeNull();
    expect(await readThumbnail(testAccountScope(), "m7", "light")).toBeNull();
    expect(await readThumbnail(testAccountScope(), "m7", "dark")).toBeNull();
  });

  it("duplicating carries a single image; deleting leaves none", async () => {
    await saveThumbnail(testAccountScope(), "a1", S);
    await copyThumbnail(testAccountScope(), "a1", "a2");
    expect(text(await readThumbnail(testAccountScope(), "a2"))).toBe("single-image");
    expect(text(await readThumbnail(testAccountScope(), "a2", "dark"))).toBe("single-image");
    await removeThumbnail(testAccountScope(), "a1");
    expect(await readThumbnail(testAccountScope(), "a1")).toBeNull();
    expect(await files()).toEqual(["a2.png"]);
  });

  it("duplicating carries a themed pair and never a pending write; deleting leaves none, pending included", async () => {
    await saveThemedThumbnail(testAccountScope(), "b1", "light", "c1", L);
    await saveThemedThumbnail(testAccountScope(), "b1", "dark", "c1", D);
    await saveThemedThumbnail(testAccountScope(), "b1", "light", "c2", Buffer.from("pending"));
    await copyThumbnail(testAccountScope(), "b1", "b2");
    expect(text(await readThumbnail(testAccountScope(), "b2", "light"))).toBe("light-image");
    expect(text(await readThumbnail(testAccountScope(), "b2", "dark"))).toBe("dark-image");
    const after = await files();
    expect(after.filter((f) => f.startsWith("b2"))).toEqual(["b2.c1.dark.png", "b2.c1.light.png", "b2.json"]);
    expect(after.some((f) => f.includes("b1") && f.includes("c2"))).toBe(true);
    await removeThumbnail(testAccountScope(), "b1");
    expect(await readThumbnail(testAccountScope(), "b1", "light")).toBeNull();
    expect(await readThumbnail(testAccountScope(), "b1")).toBeNull();
    expect((await files()).filter((f) => f.includes("b1"))).toEqual([]);
  });

  it("copying from a map with no image starts the copy from the placeholder", async () => {
    await copyThumbnail(testAccountScope(), "z1", "z2");
    expect(await readThumbnail(testAccountScope(), "z2")).toBeNull();
  });

  it("a themed write lands whole: the published file is the write's own bytes", async () => {
    await saveThemedThumbnail(testAccountScope(), "w1", "light", "c1", L);
    await saveThemedThumbnail(testAccountScope(), "w1", "dark", "c1", D);
    const set = JSON.parse(await readFile(thumbnailManifestPath("w1"), "utf8")) as { light: string; dark: string };
    const root = path.dirname(thumbnailPath("w1"));
    expect((await readFile(path.join(root, set.light))).toString()).toBe("light-image");
    expect((await readFile(path.join(root, set.dark))).toString()).toBe("dark-image");
  });
});

describe("a pair publishes as one set, and abandoned cycles expire", () => {
  it("a held write left behind by an abandoned cycle expires on the map's next themed write; a young one and the published set are untouched", async () => {
    const { utimes } = await import("node:fs/promises");
    await saveThemedThumbnail(testAccountScope(), "x1", "light", "c1", L);
    await saveThemedThumbnail(testAccountScope(), "x1", "dark", "c1", D);
    await saveThemedThumbnail(testAccountScope(), "x1", "light", "old", Buffer.from("abandoned"));
    const stale = (await files()).find((f) => f.includes("x1.old.light"))!;
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path.join(dir, "data", "thumbnails", stale), past, past);
    await saveThemedThumbnail(testAccountScope(), "x1", "light", "young", Buffer.from("in-flight"));
    // A new themed write on another map does not sweep this one either way.
    expect(await saveThemedThumbnail(testAccountScope(), "x1", "dark", "c9", Buffer.from("other"))).toBe("held");
    const after = await files();
    expect(after.some((f) => f.includes("x1.old."))).toBe(false);
    expect(after.some((f) => f.includes("x1.young.light"))).toBe(true);
    expect(text(await readThumbnail(testAccountScope(), "x1", "light"))).toBe("light-image");
    expect(text(await readThumbnail(testAccountScope(), "x1", "dark"))).toBe("dark-image");
  });
});
