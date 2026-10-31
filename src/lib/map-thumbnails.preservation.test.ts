import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { insertMap } from "@/lib/metadata/maps";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

/**
 * A published pair is never lost to a reader and never altered by a
 * failed publication. Two interleavings break that unless the storage
 * holds it: a reader that read the manifest just before a new capture
 * retired the files it names, and a write that reuses the published
 * pair's cycle while the switch that would publish it fails. Each case
 * checks that its injection really happened, so it cannot pass by
 * missing the window it is about.
 */

let failOn: ((to: string) => boolean) | null = null;
let failures = 0;
let afterManifestRead: ((manifest: string) => Promise<void>) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failOn?.(to)) {
        failures += 1;
        throw Object.assign(new Error("injected: disk full"), { code: "ENOSPC" });
      }
      return actual.renameSync(from, to);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (afterManifestRead && path.basename(String(args[0])) === "m.json") {
        const pause = afterManifestRead;
        afterManifestRead = null;
        await pause(String(result));
      }
      return result;
    }) as typeof actual.readFile,
  };
});

const { readThumbnail, saveThemedThumbnail } = await import("./map-thumbnails");

let dir: string;
const thumbs = () => path.join(dir, "data", "thumbnails");
const text = (b: Buffer | null) => (b ? b.toString() : null);
const scope = () => testAccountScope();

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  const template = createMap(scope(), "Thumbnail fixture");
  insertMap(scope(), { ...template, id: "m" });
  failOn = null;
  failures = 0;
  afterManifestRead = null;
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("a published pair survives a reader and a failed publication", () => {
  it("a reader holding the previous manifest while a new capture retires its files still gets an image", async () => {
    await saveThemedThumbnail(scope(), "m", "light", "c1", Buffer.from("light-1"));
    await saveThemedThumbnail(scope(), "m", "dark", "c1", Buffer.from("dark-1"));

    let heldManifest = "";
    let retired = false;
    afterManifestRead = async (manifest) => {
      heldManifest = manifest;
      await saveThemedThumbnail(scope(), "m", "light", "c2", Buffer.from("light-2"));
      await saveThemedThumbnail(scope(), "m", "dark", "c2", Buffer.from("dark-2"));
      retired = !existsSync(path.join(thumbs(), "m.c1.light.png")) &&
        !existsSync(path.join(thumbs(), "m.c1.dark.png"));
    };

    const read = await readThumbnail(scope(), "m", "light");

    // The injection: the reader held the first cycle's manifest, and the
    // files it names were gone before it read them.
    expect(heldManifest).toContain("m.c1.light.png");
    expect(retired).toBe(true);
    // A complete pair existed throughout; the reader gets it.
    expect(text(read)).toBe("light-2");
  });

  it("a write reusing the published cycle whose switch fails leaves the previous pair as it was", async () => {
    await saveThemedThumbnail(scope(), "m", "light", "c1", Buffer.from("light-2"));
    await saveThemedThumbnail(scope(), "m", "dark", "c1", Buffer.from("dark-2"));

    failOn = (to) => path.basename(to) === "m.json";
    await expect(
      saveThemedThumbnail(scope(), "m", "light", "c1", Buffer.from("light-3")),
    ).rejects.toMatchObject({ code: "storage_exhausted", status: 507 });
    failOn = null;

    // The injection: the manifest switch was attempted and failed.
    expect(failures).toBeGreaterThan(0);
    expect(text(await readThumbnail(scope(), "m", "light"))).toBe("light-2");
    expect(text(await readThumbnail(scope(), "m", "dark"))).toBe("dark-2");
  });

  it("a write reusing the published cycle is held, and its partner publishes the new pair whole", async () => {
    await saveThemedThumbnail(scope(), "m", "light", "c1", Buffer.from("light-2"));
    await saveThemedThumbnail(scope(), "m", "dark", "c1", Buffer.from("dark-2"));

    expect(await saveThemedThumbnail(scope(), "m", "light", "c1", Buffer.from("light-3"))).toBe("held");
    expect(text(await readThumbnail(scope(), "m", "light"))).toBe("light-2");
    expect(text(await readThumbnail(scope(), "m", "dark"))).toBe("dark-2");

    expect(await saveThemedThumbnail(scope(), "m", "dark", "c1", Buffer.from("dark-3"))).toBe("published");
    expect(text(await readThumbnail(scope(), "m", "light"))).toBe("light-3");
    expect(text(await readThumbnail(scope(), "m", "dark"))).toBe("dark-3");
  });
});
