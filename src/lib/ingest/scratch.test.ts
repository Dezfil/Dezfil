import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanIngestScratch, ingestScratchDir } from "./scratch";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("cleanIngestScratch", () => {
  it("removes orphaned scratch files and leaves an empty directory", async () => {
    await mkdir(ingestScratchDir(), { recursive: true });
    await writeFile(path.join(ingestScratchDir(), "orphan-a"), "partial");
    await writeFile(path.join(ingestScratchDir(), "orphan-b.csv"), "partial");
    await cleanIngestScratch();
    await expect(readdir(ingestScratchDir())).resolves.toEqual([]);
  });

  it("never touches the durable Overpass cache", async () => {
    const cache = path.join(dir, "data", "cache", "overpass");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "entry.json"), "{}");
    await mkdir(ingestScratchDir(), { recursive: true });
    await writeFile(path.join(ingestScratchDir(), "orphan"), "x");
    await cleanIngestScratch();
    await expect(readdir(cache)).resolves.toEqual(["entry.json"]);
  });

  it("is safe when the scratch directory does not exist yet", async () => {
    await expect(cleanIngestScratch()).resolves.toBeUndefined();
    await expect(readdir(ingestScratchDir())).resolves.toEqual([]);
  });

  it("runs from the real boot hook", async () => {
    await mkdir(ingestScratchDir(), { recursive: true });
    await writeFile(path.join(ingestScratchDir(), "left-by-a-crash"), "x");
    const cache = path.join(dir, "data", "cache", "overpass");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "entry.json"), "{}");

    const previous = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      const { register } = await import("@/instrumentation");
      await register();
    } finally {
      if (previous === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = previous;
    }
    await expect(readdir(ingestScratchDir())).resolves.toEqual([]);
    await expect(readdir(cache)).resolves.toEqual(["entry.json"]);
  });
});
