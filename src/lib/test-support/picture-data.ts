import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
/** Each worker owns a distinct store within the run's required scratch root. */
export function isolatePictureData(): void {
  const parent = process.env.DEZFIL_DATA_DIR;
  if (!parent) throw new Error("Picture tests require an isolated data directory.");
  const directory = mkdtempSync(path.join(parent, "case-"));
  process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb();
  afterAll(() => { closeMetadataDb(); process.env.DEZFIL_DATA_DIR = parent; rmSync(directory, { recursive: true, force: true }); });
}
