import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { insertMap } from "@/lib/metadata/maps";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * a publication must be failure-atomic. The
 * review's injection: the second of the pair's renames fails after the
 * first has already overwritten a published image, and the map is left
 * with an old light beside a new dark, permanently, despite a failed
 * write. The set must switch as one, so a failed replacement leaves the
 * previous pair intact.
 */

const renamesOntoPublishedNames: string[] = [];
let failOn: ((to: string) => boolean) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      // A rename onto "<id>.<theme>.png" is the old design's way of
      // assembling a set half by half.
      if (/^[^.]+\.(light|dark)\.png$/.test(path.basename(to))) {
        renamesOntoPublishedNames.push(path.basename(to));
      }
      if (failOn?.(to)) throw Object.assign(new Error("injected: disk full"), { code: "ENOSPC" });
      return actual.renameSync(from, to);
    },
  };
});

const { readThumbnail, saveThemedThumbnail } = await import("./map-thumbnails");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  const scope = testAccountScope();
  const template = createMap(scope, "Thumbnail fixture");
  for (const id of ["m","n"]) insertMap(scope, { ...template, id });
  renamesOntoPublishedNames.length = 0;
  failOn = null;
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const text = (b: Buffer | null) => (b ? b.toString() : null);

describe("a publication is failure-atomic", () => {
  it("the injection raised at review: the dark half's rename fails after the light half landed; the previous pair must be intact", async () => {
    await saveThemedThumbnail(testAccountScope(), "m", "light", "c1", Buffer.from("light-1"));
    await saveThemedThumbnail(testAccountScope(), "m", "dark", "c1", Buffer.from("dark-1"));
    // The next cycle: its light is written first, its dark completes the
    // pair. The completing write renames its own half first and the
    // partner second; the partner's rename onto the published light fails.
    await saveThemedThumbnail(testAccountScope(), "m", "light", "c2", Buffer.from("light-2"));
    failOn = (to) => /m\.light\.png$/.test(to);
    await saveThemedThumbnail(testAccountScope(), "m", "dark", "c2", Buffer.from("dark-2")).catch(() => undefined);
    const light = text(await readThumbnail(testAccountScope(), "m", "light"));
    const dark = text(await readThumbnail(testAccountScope(), "m", "dark"));
    expect(`${light} + ${dark}`).toMatch(/^(light-1 \+ dark-1|light-2 \+ dark-2)$/);
    // And a set is never assembled by renaming onto a published name.
    expect(renamesOntoPublishedNames).toEqual([]);
  });

  it("a failure at the switch itself leaves the previous pair served and the write refused", async () => {
    await saveThemedThumbnail(testAccountScope(), "n", "light", "c1", Buffer.from("light-1"));
    await saveThemedThumbnail(testAccountScope(), "n", "dark", "c1", Buffer.from("dark-1"));
    await saveThemedThumbnail(testAccountScope(), "n", "light", "c2", Buffer.from("light-2"));
    // Whatever single file the publication switches on, its rename fails.
    failOn = (to) => path.basename(to).startsWith("n.") && !/\.png$/.test(to);
    await expect(saveThemedThumbnail(testAccountScope(), "n", "dark", "c2", Buffer.from("dark-2"))).rejects.toThrow("injected");
    expect(text(await readThumbnail(testAccountScope(), "n", "light"))).toBe("light-1");
    expect(text(await readThumbnail(testAccountScope(), "n", "dark"))).toBe("dark-1");
    // A later cycle still publishes over it whole.
    failOn = null;
    await saveThemedThumbnail(testAccountScope(), "n", "light", "c3", Buffer.from("light-3"));
    expect(await saveThemedThumbnail(testAccountScope(), "n", "dark", "c3", Buffer.from("dark-3"))).toBe("published");
    expect(text(await readThumbnail(testAccountScope(), "n", "light"))).toBe("light-3");
    expect(text(await readThumbnail(testAccountScope(), "n", "dark"))).toBe("dark-3");
    const names = await readdir(path.join(dir, "data", "thumbnails"));
    expect(names.some((f) => f.startsWith("n.c1."))).toBe(false);
  });
});
