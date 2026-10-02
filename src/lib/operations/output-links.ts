import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { reachableDatasetIds } from "@/lib/auth/reach";
import { metadataDb } from "@/lib/metadata/db";
import type { CascadeRun } from "@/lib/metadata/cascades";

export type OutputLink = { id: string; name: string };

/**
 * Which recorded output links a reader may follow. A run record and a step
 * name the datasets they produced; a link is shown when the reader reaches
 * that dataset, and a link to a dataset that no longer exists is shown to
 * whoever recorded it, its run's initiator or its workflow's owner, as the
 * record of something gone. Anyone else learns nothing about a dataset out of
 * their reach: the link is left out.
 */
export function linkFilter(scope: AccountScope, recorders: readonly (string | null)[], db: Database = metadataDb()) {
  const reachable = reachableDatasetIds(scope, db);
  const recorder = recorders.includes(scope.accountId);
  const exists = db.prepare("SELECT 1 FROM data_tables WHERE id = ?");
  return (link: OutputLink | null): OutputLink | null => {
    if (!link) return null;
    if (reachable.has(link.id)) return link;
    return recorder && exists.get(link.id) === undefined ? link : null;
  };
}

/** The link filter for one run: its initiator and its workflow's owner
 * recorded it. */
export function outputLinks(scope: AccountScope, run: CascadeRun, db: Database = metadataDb()) {
  const row = db.prepare(`SELECT c.initiator_id, r.owner_id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id WHERE c.id = ?`)
    .get(run.id) as { initiator_id: string | null; owner_id: string } | undefined;
  return linkFilter(scope, [row?.initiator_id ?? null, row?.owner_id ?? null], db);
}
