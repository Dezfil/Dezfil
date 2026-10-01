import { metadataDb } from "@/lib/metadata/db";
import type { Database } from "better-sqlite3";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { layersWithEvidenceOf, runningLayersOf } from "@/lib/tiles/evidence";

/**
 * Which retained tiles depend on a dataset, and what their data identity is
 * now. Both read the identities an evaluation recorded when it drew the
 * tiles, never the SQL text: a layer reading `bo.roads` depends on Bo's
 * dataset and never on the map owner's same-named one, and a plain name in
 * a map's SQL depends on the home's dataset whoever looks.
 */

/** The layers whose tiles drew this dataset, as recorded by their last
 * build or by a build still running. Refresh invalidates their tile records;
 * deletion reclaims their archives. */
export function dependentLayerIds(datasetId: string, db: Database = metadataDb()): string[] {
  const candidates = new Set([...layersWithEvidenceOf(datasetId), ...runningLayersOf(datasetId)]);
  if (candidates.size === 0) return [];
  const rows = db.prepare("SELECT id FROM layers WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
    .all(JSON.stringify([...candidates])) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Recorded identities with the artifact each dataset holds now: the data
 * identity a tile fingerprint folds in. A refresh mints a new artifact file
 * and a deletion leaves none, so a fingerprint over these can never accept
 * tiles of older data as fresh, even when an explicit invalidation was lost. */
export function currentInputs(inputs: ArtifactInputs, db: Database = metadataDb()): ArtifactInputs {
  if (inputs.datasets.length === 0) return inputs;
  const rows = db.prepare("SELECT id, file FROM data_tables WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(inputs.datasets.map((input) => input.id))) as { id: string; file: string }[];
  const files = new Map(rows.map((row) => [row.id, row.file]));
  return { catalogue: inputs.catalogue, datasets: inputs.datasets.map((input) => ({ id: input.id, file: files.get(input.id) ?? "" })) };
}
