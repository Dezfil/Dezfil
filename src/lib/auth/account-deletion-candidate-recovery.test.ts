import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
it("reads and removes, with its export, a staged export's record named as an earlier run named it", async () => {
  directory = await mkdtemp(path.join(root, "candidate-recovery-")); process.env.DEZFIL_DATA_DIR = directory;
  for (const folder of ["exports", "file-owners", "tables"]) await mkdir(path.join(directory, folder), { recursive: true });
  // The record as it was named before its name carried its place: the digest of the path alone.
  const earlier = "exports/earlier.zip";
  await writeFile(path.join(directory, "file-owners", `${createHash("sha256").update(earlier).digest("hex")}.json`),
    JSON.stringify({ accountId: "independent", file: earlier, directory: false }));
  await writeFile(path.join(directory, earlier), earlier);
  registerAccountFile("independent", "exports/current.zip"); registerAccountFile("independent", "tables/retained.parquet");
  expect(ownedFileRecords().map(record => record.file).sort()).toEqual(["exports/current.zip", earlier, "tables/retained.parquet"]);
  await cleanAbandonedDeletionCandidates();
  expect(await readdir(path.join(directory, "exports"))).toEqual([]);
  expect(ownedFileRecords().map(record => record.file)).toEqual(["tables/retained.parquet"]);
  expect(await readdir(path.join(directory, "file-owners"))).toHaveLength(1);
});
