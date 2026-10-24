/**
 * Next.js startup hook: fail fast at boot when the data directory is unusable
 * instead of failing on the first upload.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sessionCookieName } = await import("@/lib/auth/session-cookie");
    sessionCookieName();
    const { ensureDataDir } = await import("@/lib/data-dir");
    const { dataDir } = await import("@/lib/config");
    await ensureDataDir(dataDir());
    const { metadataDb } = await import("@/lib/metadata/db");
    metadataDb();
    const { discoverAccountDeletions } = await import("@/lib/auth/account-deletion-journal");
    discoverAccountDeletions();
    const { maintainCredentials } = await import("@/lib/auth/credential-maintenance");
    maintainCredentials();
    // A crashed process can leave tile exports behind; sweep them. Served
    // archives without a tile record are never authoritative and would
    // otherwise keep serving deleted data — they go too.
    const { cleanTileScratch, sweepTileArchives } =
      await import("@/lib/tiles/build");
    await cleanTileScratch();
    await sweepTileArchives();
    // Same for partial uploads and downloads in the ingest scratch. The
    // durable Overpass cache is deliberately not touched.
    const { cleanIngestScratch } = await import("@/lib/ingest/scratch");
    await cleanIngestScratch();
    // A crashed trusted engine's spill, up to four times its memory budget,
    // would otherwise stay until the first trusted work starts an engine. No
    // engine runs yet, so the whole directory goes.
    const { rm } = await import("node:fs/promises");
    const path = await import("node:path");
    await rm(path.join(dataDir(), "engine-spill"), { recursive: true, force: true });
    const { cleanAbandonedDeletionCandidates } = await import("@/lib/auth/account-deletion-candidate-recovery");
    await cleanAbandonedDeletionCandidates();
    // Artifact files no registered table references — stranded by a crash
    // or an abandoned retirement — are permanent without this.
    const { sweepTableArtifacts } = await import("@/lib/ingest/sweep");
    await sweepTableArtifacts();
    // A profile picture file is live only while its account's row names its
    // version; a replaced one whose removal failed, a partial write and a
    // file whose commit never happened go here.
    const { sweepProfilePictures } = await import("@/lib/profile-pictures/store");
    await sweepProfilePictures();
    // The run lane is in-process, so a stopped process leaves job rows still
    // claiming to be queued or running with nothing behind them. They are
    // settled here, before anything can read them; none is re-executed. A
    // cascade's drive loop is in-process too, and unlike a job nothing else
    // would ever settle it — so it is settled `interrupted` here, after the job
    // sweep, and nothing is resumed.
    const { recoverInterruptedRuns, recoverInterruptedCascades } =
      await import("@/lib/operations/recover");
    recoverInterruptedRuns();
    recoverInterruptedCascades();
    const { startPictures } = await import("@/lib/pictures/start");
    startPictures();
  }
}
