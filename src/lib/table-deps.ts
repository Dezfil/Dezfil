import { metadataDb } from "@/lib/metadata/db";
import type { Database } from "better-sqlite3";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { archiveWithoutEvidence, layersWithEvidenceOf, runningLayersOf } from "@/lib/tiles/evidence";

/**
 * Which retained tiles depend on a dataset, and what their data identity is
 * now. Both read the identities an evaluation recorded when it drew the
 * tiles: a layer reading `bo.roads` depends on Bo's dataset and never on the
 * map owner's same-named one, and a plain name in a map's SQL depends on the
 * home's dataset whoever looks. An archive built before archives recorded
 * their inputs has no identities to read; for it alone the SQL text decides,
 * as it did when that archive was built.
 */

/** The layers whose tiles drew this dataset, as recorded by their last
 * build or by a build still running, and the archives of before on its
 * owner's maps whose SQL names it. Refresh invalidates their tile records;
 * deletion reclaims their archives. */
export function dependentLayerIds(datasetId: string, db: Database = metadataDb()): string[] {
  const candidates = new Set([...layersWithEvidenceOf(datasetId), ...runningLayersOf(datasetId),
    ...unattributedLayersOf(datasetId, db)]);
  if (candidates.size === 0) return [];
  const rows = db.prepare("SELECT id FROM layers WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
    .all(JSON.stringify([...candidates])) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * Does this SQL name the table as a whole identifier? Bounded by
 * non-identifier characters, case-insensitive as the engine binds names, so
 * `main_roads` and `roads_2` are not references to `roads`. Conservative
 * beyond that: an occurrence in a quoted identifier, an alias or a string
 * literal counts, because an over-match costs one rebuild while an
 * under-match keeps serving data that is gone.
 */
function sqlNamesTable(sql: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(sql);
}

/** The layers on the dataset owner's own maps whose archive predates
 * recorded inputs and whose SQL names the dataset: that archive could only
 * have drawn its map owner's datasets. */
function unattributedLayersOf(datasetId: string, db: Database): string[] {
  const dataset = db.prepare("SELECT name, owner_id FROM data_tables WHERE id = ?").get(datasetId) as
    { name: string; owner_id: string | null } | undefined;
  if (!dataset) return [];
  const layers = db.prepare("SELECT l.id, l.sql FROM layers l JOIN maps m ON m.id = l.map_id WHERE m.owner_id IS ?")
    .all(dataset.owner_id) as { id: string; sql: string }[];
  return layers.filter((layer) => sqlNamesTable(layer.sql, dataset.name) && archiveWithoutEvidence(layer.id)).map((layer) => layer.id);
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
