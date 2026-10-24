import { cpSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { requireAccountScope } from "@/lib/auth/scope";
import { cleanAbandonedDeletionCandidates } from "@/lib/auth/account-deletion-candidate-recovery";
import { cleanIngestScratch } from "@/lib/ingest/scratch";
import { sweepTableArtifacts } from "@/lib/ingest/sweep";
import { cleanTileScratch, sweepTileArchives } from "@/lib/tiles/build";
import { forgetStorageRead, readStorage } from "@/lib/system/storage";
import { readProfilePicture } from "./read";
import { admitPictureWrite, publishPicture, sweepProfilePictures } from "./store";

/**
 * A picture outlives the server: after a restart, and in a copy of the
 * whole data folder started somewhere else, as the backup page says to
 * make one, the person's picture is served with the same bytes at the same
 * version, and Storage counts it under its kind.
 */
const root = process.env.DEZFIL_DATA_DIR!;
let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(root, "picture-backup-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(base, "data"));
  closeMetadataDb();
  forgetStorageRead();
  for (const id of ["ada", "admin"]) testAccountScope(undefined, id);
  metadataDb().exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'; UPDATE accounts SET last_sign_in_at = 'time'");
});
afterEach(() => { forgetStorageRead(); closeMetadataDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

const PICTURE = Buffer.from("ada's picture, as the server keeps it");
async function set() {
  const write = admitPictureWrite("ada", "ada");
  try { await publishPicture(write, PICTURE, (db) => { requireAccountScope(testAccountScope(db, "ada"), db); }); }
  finally { write.release(); }
}
const version = () => getAccount("ada")!.pictureVersion;
const served = () => readProfilePicture(testAccountScope(undefined, "admin"), getAccount("ada")!.sqlName, version() ?? null);
/** What a start runs over the data folder, in its order. */
async function start() {
  closeMetadataDb();
  forgetStorageRead();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await cleanTileScratch(); await sweepTileArchives(); await cleanIngestScratch();
  await cleanAbandonedDeletionCandidates(); await sweepTableArtifacts(); await sweepProfilePictures();
}
async function stored() {
  const admin = authenticateSession(issueSession(getAccount("admin")!, metadataDb(), Date.now()).secret)!;
  return (await readStorage(admin)).kinds.profile_pictures;
}

it("serves the same picture at the same version after a restart, counted under its kind", async () => {
  await set();
  const before = { version: version(), picture: await served() };
  expect(before.picture.bytes.equals(PICTURE)).toBe(true);
  await start();
  expect(version()).toBe(before.version);
  expect(await served()).toEqual(before.picture);
  expect(await stored()).toEqual({ bytes: PICTURE.length, files: 1, finished: true });
});

it("serves it from a copy of the whole data folder started elsewhere, the original gone", async () => {
  await set();
  const before = { version: version(), picture: await served() };
  closeMetadataDb();
  const restored = path.join(base, "restored");
  cpSync(path.join(base, "data"), restored, { recursive: true });
  rmSync(path.join(base, "data"), { recursive: true, force: true });
  vi.stubEnv("DEZFIL_DATA_DIR", restored);
  await start();
  expect(version()).toBe(before.version);
  expect(await served()).toEqual(before.picture);
  expect(await stored()).toEqual({ bytes: PICTURE.length, files: 1, finished: true });
});
