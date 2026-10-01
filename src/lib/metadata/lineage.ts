import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import { randomUUID } from "node:crypto";
import { metadataDb } from "./db";

/**
 * The table-to-table lineage edge.
 *
 * An edge says: *this step, producing this output, read this input — and the
 * artifact it read was this one.*
 *
 * **The bound artifact is the whole point, and it is what an earlier design got
 * wrong.** Comparing when a producer last succeeded against when a consumer last
 * succeeded cannot tell which generation the consumer actually read: a consumer
 * that binds P0, then has P1 published under it, then finishes, has a *later*
 * completion time than its producer while holding older data. Recording the
 * artifact removes the question — staleness is a mismatch between what a step
 * read and what its input now holds, and the registry swap that changes an
 * artifact is itself the durable record of the change. There is no second write
 * to be lost.
 *
 * Edges carry ids, never names alone, because a name can be reclaimed by a
 * different table; the name is kept alongside so a row can still explain itself
 * after the id it refers to is gone.
 *
 * No foreign key reaches `data_tables`. The ids here are exactly what let a step
 * say "broken" once an input is deleted, and a cascade would delete the
 * explanation with the table.
 */

export interface LineageEdge {
  id: string;
  stepId: string;
  outputTableId: string;
  inputTableId: string;
  /** The input's name at the moment it was read; kept for the broken case. */
  inputTableName: string;
  /** The artifact this run actually bound — the generation it read. */
  boundArtifact: string;
  recordedAt: string;
}

interface Row {
  id: string;
  step_id: string;
  output_table_id: string;
  input_table_id: string;
  input_table_name: string;
  bound_artifact: string;
  recorded_at: string;
}

function hydrate(r: Row): LineageEdge {
  return {
    id: r.id,
    stepId: r.step_id,
    outputTableId: r.output_table_id,
    inputTableId: r.input_table_id,
    inputTableName: r.input_table_name,
    boundArtifact: r.bound_artifact,
    recordedAt: r.recorded_at,
  };
}

export interface NewEdge {
  inputTableId: string;
  inputTableName: string;
  boundArtifact: string;
}

/**
 * Replace a step's edges with the set its latest run bound.
 *
 * **Replace, not append.** A re-run may read different tables than the run
 * before it, and an edge left behind would keep propagating staleness from a
 * table the step no longer reads. Deleting and inserting together is why this
 * takes a database handle: it belongs inside the publication transaction, so no
 * reader ever sees a step with half its lineage.
 */
export function replaceEdges(
  scope: AccountScope,
  stepId: string,
  outputTableId: string,
  edges: NewEdge[],
  db: Database = metadataDb(),
): void {
  const owner = requireAccountScope(scope, db);
  requireReachable(scope, "step", stepId, db);
  // A bound input may have been deleted while its pinned artifact was read.
  // A new output is recorded before insertion in the publication transaction.
  // The output is the runner's own; every input that still exists is one the
  // runner reaches. Absent ones remain recorded by their original identity
  // and never resolve through a reclaimed name.
  const output = db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(outputTableId) as { owner_id: string | null } | undefined;
  if (output && output.owner_id !== owner) throw resourceAbsent();
  const reachable = reachableDatasetIds(scope, db);
  for (const edge of edges) {
    if (db.prepare("SELECT id FROM data_tables WHERE id = ?").get(edge.inputTableId) && !reachable.has(edge.inputTableId)) throw resourceAbsent();
  }
  const now = new Date().toISOString();
  // Edges are the runner's: a run replaces what the same account's earlier
  // run of this step bound, and records itself as the runner.
  db.prepare(`DELETE FROM lineage_edges WHERE step_id = ? AND (runner_id = ? OR runner_id IS NULL)`).run(stepId, owner);
  const insert = db.prepare(
    `INSERT INTO lineage_edges
       (id, step_id, output_table_id, input_table_id, input_table_name,
        bound_artifact, recorded_at, runner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of edges) {
    insert.run(
      randomUUID(),
      stepId,
      outputTableId,
      e.inputTableId,
      e.inputTableName,
      e.boundArtifact,
      now,
      owner,
    );
  }
}

/** What this step read. */
export function edgesForStep(
  scope: AccountScope,
  stepId: string,
  db: Database = metadataDb(),
): LineageEdge[] {
  requireOwnedResource(scope, "step", stepId, db);
  const owner = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT e.* FROM lineage_edges e LEFT JOIN data_tables t ON t.id = e.input_table_id
    WHERE e.step_id = ? AND (t.id IS NULL OR t.owner_id = ?) ORDER BY e.input_table_name`).all(stepId, owner) as Row[];
  return rows.map(hydrate);
}

/**
 * What a step read, as one reader of its workflow may see it: every recorded
 * edge whose input the reader reaches, and, for the workflow's owner, every
 * edge whose input no longer exists, the record of an input since deleted.
 * An input someone else still holds out of the reader's reach is left out,
 * never named.
 */
export function reachedEdgesForStep(
  scope: AccountScope,
  stepId: string,
  reachable: ReadonlySet<string>,
  db: Database = metadataDb(),
  /** Only this runner's edges: the run a view describes. */
  runner?: string | null,
): LineageEdge[] {
  const owner = requireReachable(scope, "step", stepId, db).relation === "owner";
  if (runner === null) return [];
  const rows = db.prepare(`SELECT e.*, t.id AS live FROM lineage_edges e LEFT JOIN data_tables t ON t.id = e.input_table_id
    WHERE e.step_id = ? ${runner === undefined ? "" : "AND e.runner_id = ?"} ORDER BY e.input_table_name`)
    .all(...(runner === undefined ? [stepId] : [stepId, runner])) as (Row & { live: string | null })[];
  return rows.filter((row) => reachable.has(row.input_table_id) || (owner && row.live === null)).map(hydrate);
}

/** Which steps read this table — the direction staleness travels. */
export function edgesForInput(
  scope: AccountScope,
  inputTableId: string,
  db: Database = metadataDb(),
): LineageEdge[] {
  const owner = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT e.* FROM lineage_edges e JOIN recipe_steps s ON s.id = e.step_id
    JOIN recipes r ON r.id = s.recipe_id LEFT JOIN data_tables t ON t.id = e.input_table_id
    WHERE e.input_table_id = ? AND r.owner_id = ? AND (t.id IS NULL OR t.owner_id = ?)`)
    .all(inputTableId, owner, owner) as Row[];
  return rows.map(hydrate);
}

/** Drop a step's edges without touching the step — used when a step is
 * detached, so nothing keeps propagating through a producer that is gone. */
export function clearEdges(scope: AccountScope, stepId: string, db: Database = metadataDb()): number {
  requireOwnedResource(scope, "step", stepId, db);
  return db.prepare(`DELETE FROM lineage_edges WHERE step_id = ?`).run(stepId).changes;
}
