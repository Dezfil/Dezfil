import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * a themed pair must publish as one set. Two cycles completing at
 * once interleaved their per-theme renames in the review's reproduction, leaving A's light
 * beside B's dark. The ordering is forced here rather than hoped for: a rename yields, and
 * cycle A's light rename (its partner, renamed second) yields longest, so without one
 * publication per map the order would be A dark, B dark, B light, A light, the cleanups after
 * (the manifest switch makes the pair one file; the case still holds that one
 * cycle's pair results).
 */

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const wait = /\.A\.light\.png$/.test(from) ? 4 : 2;
      await new Promise((r) => setTimeout(r, wait));
      return actual.rename(from, to);
    },
    // The cleanup's listing yields longest, so a publication's sweep
    // cannot hide the interleaving by deleting the other cycle's file
    // before its rename runs.
    readdir: (async (dir: string, ...rest: unknown[]) => {
      await new Promise((r) => setTimeout(r, 10));
      return (actual.readdir as (...a: unknown[]) => unknown)(dir, ...rest);
    }) as typeof actual.readdir,
  };
});

const { readThumbnail, saveThemedThumbnail } = await import("./map-thumbnails");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("a themed pair publishes as one set", () => {
  it("two cycles completing at once leave one cycle's pair and nothing pending", async () => {
    await saveThemedThumbnail("m", "light", "A", Buffer.from("light-A"));
    await saveThemedThumbnail("m", "light", "B", Buffer.from("light-B"));
    const outcomes = await Promise.all([
      saveThemedThumbnail("m", "dark", "A", Buffer.from("dark-A")),
      saveThemedThumbnail("m", "dark", "B", Buffer.from("dark-B")),
    ]);
    const light = (await readThumbnail("m", "light"))!.toString();
    const dark = (await readThumbnail("m", "dark"))!.toString();
    expect(light.slice(-1), `${light} + ${dark}`).toBe(dark.slice(-1));
    // Exactly one publication. The other cycle's dark write ran in the
    // next turn, found its light already discarded, and is held alone:
    // an orphan the TTL sweep reclaims, never a half of the published pair.
    expect(outcomes.filter((o) => o === "published")).toHaveLength(1);
    const loser = light.slice(-1) === "A" ? "B" : "A";
    const names = await readdir(path.join(dir, "data", "thumbnails"));
    const held = names.filter((n) => /^m\..+\.(light|dark)\.png$/.test(n) && n.includes(`.${loser}.`));
    expect(held).toEqual([`m.${loser}.dark.png`]);
  });
});
