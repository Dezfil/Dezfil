import { existsSync, renameSync, rmSync } from "node:fs";
import { tileArchivePath } from "./paths";
import { tileEvidencePath, writeTileEvidence, type TileEvidence } from "./evidence";

/** Keep both old files until the record commits. This publication has no
 * asynchronous boundary: a render cannot observe the temporary mismatch.
 * Rollback uses renames, without needing space for a second copy. */
export function publishTileArchive(layerId: string, candidate: string, evidence: TileEvidence, commit: () => void): void {
  const archive = tileArchivePath(layerId), proof = tileEvidencePath(layerId);
  const previousArchive = `${candidate}.previous`, previousProof = `${candidate}.evidence`;
  let keptArchive = false, keptProof = false, swapped = false, wroteProof = false;
  try {
    if (existsSync(archive)) { renameSync(archive, previousArchive); keptArchive = true; }
    if (existsSync(proof)) { renameSync(proof, previousProof); keptProof = true; }
    writeTileEvidence(layerId, evidence); wroteProof = true;
    renameSync(candidate, archive); swapped = true;
    commit();
  } catch (error) {
    if (keptArchive) renameSync(previousArchive, archive);
    else if (swapped) rmSync(archive, { force: true });
    if (keptProof) renameSync(previousProof, proof);
    else if (wroteProof) rmSync(proof, { force: true });
    throw error;
  }
  // Publication succeeded. A leftover backup is scratch for the boot sweep.
  for (const file of [previousArchive, previousProof]) {
    try { rmSync(file, { force: true }); }
    catch (error) { console.warn("[tiles] replaced archive cleanup failed:", error); }
  }
}
