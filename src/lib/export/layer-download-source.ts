import type { Database } from "better-sqlite3";
import { canReach, reachableDatasetIds } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";

/**
 * What a prepared layer download must still find in its claimant's reach
 * when the claim streams it: the claim is where the download is handed over,
 * so it is where reach is asked again.
 *
 * Fixed when the file is prepared, from the layer and the datasets its
 * evaluation drew. A layer on a map the claimant does not own must still be
 * reachable; so must every dataset it drew that someone else owns. What the
 * claimant owns keeps the rule a prepared download always had: their own
 * receipt, even after they delete or withdraw the source themselves.
 */
export function layerDownloadSource(
  scope: AccountScope,
  layer: { id: string; mapId: string },
  inputs: ArtifactInputs,
  db: Database = metadataDb(),
): () => boolean {
  const me = scope.accountId;
  const owner = (sql: string, id: string) => (db.prepare(sql).get(id) as { owner: string | null } | undefined)?.owner ?? null;
  const ownMap = owner("SELECT owner_id AS owner FROM maps WHERE id = ?", layer.mapId) === me;
  const others = inputs.datasets
    .map((input) => input.id)
    .filter((id) => owner("SELECT owner_id AS owner FROM data_tables WHERE id = ?", id) !== me);
  return () => {
    if (!ownMap && !canReach(scope, "layer", layer.id, db)) return false;
    if (others.length === 0) return true;
    const reach = reachableDatasetIds(scope, db);
    return others.every((id) => reach.has(id));
  };
}
