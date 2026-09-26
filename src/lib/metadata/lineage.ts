import type { Database } from "better-sqlite3";
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
  stepId: string,
  outputTableId: string,
  edges: NewEdge[],
  db: Database = metadataDb(),
): void {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM lineage_edges WHERE step_id = ?`).run(stepId);
  const insert = db.prepare(
    `INSERT INTO lineage_edges
       (id, step_id, output_table_id, input_table_id, input_table_name,
        bound_artifact, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
    );
  }
}

/** What this step read. */
export function edgesForStep(
  stepId: string,
  db: Database = metadataDb(),
): LineageEdge[] {
  const rows = db
    .prepare(`SELECT * FROM lineage_edges WHERE step_id = ? ORDER BY input_table_name`)
    .all(stepId) as Row[];
  return rows.map(hydrate);
}

/** Which steps read this table — the direction staleness travels. */
export function edgesForInput(
  inputTableId: string,
  db: Database = metadataDb(),
): LineageEdge[] {
  const rows = db
    .prepare(`SELECT * FROM lineage_edges WHERE input_table_id = ?`)
    .all(inputTableId) as Row[];
  return rows.map(hydrate);
}

/** Drop a step's edges without touching the step — used when a step is
 * detached, so nothing keeps propagating through a producer that is gone. */
export function clearEdges(stepId: string, db: Database = metadataDb()): number {
  return db.prepare(`DELETE FROM lineage_edges WHERE step_id = ?`).run(stepId).changes;
}
