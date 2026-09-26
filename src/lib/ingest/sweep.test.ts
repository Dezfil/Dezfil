import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  access,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { dataDir } from "@/lib/config";
import { sweepTableArtifacts } from "./sweep";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function registered(file: string): DataTable {
  return {
    id: "id-reg",
    name: "parks",
    sourceFilename: "parks.geojson",
    format: "geojson",
    file,
    geometryColumn: "geometry",
    geometryType: "POLYGON",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 1,
    createdAt: "2026-07-28T00:00:00Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
  };
}

describe("sweepTableArtifacts", () => {
  it("removes and logs unreferenced artifacts, never registered ones; repeat is a no-op", async () => {
    const tables = path.join(dataDir(), "tables");
    await mkdir(tables, { recursive: true });
    await writeFile(path.join(tables, "kept.parquet"), "k");
    await writeFile(path.join(tables, "orphan.parquet"), "o");
    insertTable(registered("tables/kept.parquet"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sweepTableArtifacts()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("orphan.parquet"),
      );
    } finally {
      warn.mockRestore();
    }
    await expect(
      access(path.join(tables, "kept.parquet")),
    ).resolves.toBeUndefined();
    expect(await readdir(tables)).toEqual(["kept.parquet"]);

    // Idempotent: a second boot finds nothing to do.
    expect(await sweepTableArtifacts()).toBe(0);
  });

  it("is a quiet no-op before anything was ever imported", async () => {
    expect(await sweepTableArtifacts()).toBe(0);
  });

  it("propagates a directory read failure instead of reporting a clean sweep", async () => {
    // The tables path exists but is not a directory: readdir fails with
    // something other than ENOENT, and that must surface through the
    // fail-fast boot hook — never read as "nothing to sweep".
    await mkdir(dataDir(), { recursive: true });
    await writeFile(path.join(dataDir(), "tables"), "not a directory");
    await expect(sweepTableArtifacts()).rejects.toThrow();
  });
});
