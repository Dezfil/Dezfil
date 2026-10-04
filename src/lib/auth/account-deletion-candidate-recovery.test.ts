import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanAbandonedDeletionCandidates } from "./account-deletion-candidate-recovery";
import { registerAccountFile, ownedFileRecords } from "@/lib/ingest/file-ownership";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
afterEach(async () => { process.env.DEZFIL_DATA_DIR = root; if (directory) await rm(directory, { recursive: true, force: true }); });
it("sweeps crashed private candidates and their ledger without removing published images or durable tables", async () => {
  directory = await mkdtemp(path.join(root, "candidate-recovery-")); process.env.DEZFIL_DATA_DIR = directory;
  for (const folder of ["exports", "thumbnails", "artifact-inputs/thumbnails", "tables"]) await mkdir(path.join(directory, folder), { recursive: true });
  registerAccountFile("independent", "exports/candidate.zip"); registerAccountFile("independent", "tables/retained.parquet");
  for (const file of ["exports/candidate.zip", "thumbnails/control.png", "thumbnails/control.png.part.tmp", "artifact-inputs/thumbnails/control.png.json", "artifact-inputs/thumbnails/control.png.json.part.tmp", "tables/retained.parquet"]) await writeFile(path.join(directory, file), file);
  await cleanAbandonedDeletionCandidates();
  expect(await readdir(path.join(directory, "exports"))).toEqual([]);
  expect(await readdir(path.join(directory, "thumbnails"))).toEqual(["control.png"]);
  expect(await readdir(path.join(directory, "artifact-inputs/thumbnails"))).toEqual(["control.png.json"]);
  expect(await readFile(path.join(directory, "tables/retained.parquet"), "utf8")).toBe("tables/retained.parquet");
  expect(ownedFileRecords().map(record => record.file)).toEqual(["tables/retained.parquet"]);
});
