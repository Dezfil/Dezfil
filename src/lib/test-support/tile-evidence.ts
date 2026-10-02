import { metadataDb } from "@/lib/metadata/db";
import { upsertTileRecord } from "@/lib/metadata/tiles";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { currentInputs } from "@/lib/table-deps";
import { writeTileEvidence } from "@/lib/tiles/evidence";

/**
 * Tile fixtures written the way a build commits them: a ready record and the
 * evidence of what its archive drew, naming that record. Tests that seed a
 * record by hand seed its evidence with it, or the archive is unattributed.
 */

/** Recorded identities, each with the artifact its dataset holds now. */
export function datasetInputs(ids: readonly string[], catalogue = false, db = metadataDb()): ArtifactInputs {
  return currentInputs({ catalogue, datasets: ids.map((id) => ({ id, file: "" })) }, db);
}

export function seedTileEvidence(layerId: string, fingerprint: string, builtAt: string, inputs: ArtifactInputs): void {
  writeTileEvidence(layerId, { fingerprint, builtAt, inputs });
}

export function seedReadyTiles(layerId: string, record: { fingerprint: string; featureCount: number; builtAt: string },
  inputs: ArtifactInputs, db = metadataDb()): void {
  upsertTileRecord({ layerId, state: "ready", fingerprint: record.fingerprint, error: null,
    featureCount: record.featureCount, builtAt: record.builtAt }, db);
  seedTileEvidence(layerId, record.fingerprint, record.builtAt, inputs);
}
