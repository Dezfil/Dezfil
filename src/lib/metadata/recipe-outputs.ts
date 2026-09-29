import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/** Record the dataset a successful run produced, and when it succeeded. This
 * is the stored ownership the re-run exception rests on. */
export function recordOutput(
  id: string,
  output: { id: string; name: string },
  succeededAt: string,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `UPDATE recipe_steps
     SET output_table_id = ?, output_table_name = ?, last_success_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(output.id, output.name, succeededAt, succeededAt, id);
}

/**
 * Whether this step owns exactly this table.
 *
 * The one question the admission exception may ask. It is answered from the
 * stored row and never from anything a caller supplied — subject is a grouping
 * identity any client may send, and treating it as ownership would make "reuse
 * a taken name" forgeable.
 */
export function stepOwnsOutput(
  stepId: string,
  table: { id: string; name: string },
  db: Database = metadataDb(),
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM recipe_steps
       WHERE id = ? AND output_table_id = ? AND output_table_name = ?`,
    )
    .get(stepId, table.id, table.name) as { ok: number } | undefined;
  return row !== undefined;
}

