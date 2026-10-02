import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/** Who produced an output, and through which job and run. */
export interface OutputRunner {
  accountId: string;
  jobId: string | null;
  runId: string | null;
}

/** Record the dataset a successful run produced, and when it succeeded. This
 * is the stored ownership the re-run exception rests on.
 *
 * The same success is also recorded per runner: one row for the step and the
 * account that ran it, holding the output and the job and run that produced
 * it. Both are written here, together, so no path records one without the
 * other. A write that names no runner records the workflow's owner, the only
 * account that has been able to run a step. */
export function recordOutput(
  id: string,
  output: { id: string; name: string },
  succeededAt: string,
  db: Database = metadataDb(),
  runner?: OutputRunner,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE recipe_steps
       SET output_table_id = ?, output_table_name = ?, last_success_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(output.id, output.name, succeededAt, succeededAt, id);
    db.prepare(
      `INSERT INTO step_runner_outputs
         (step_id, runner_id, output_table_id, output_table_name, job_id, run_id, succeeded_at)
       SELECT s.id, COALESCE(?, r.owner_id), ?, ?, ?, ?, ?
       FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id
       WHERE s.id = ? AND COALESCE(?, r.owner_id) IS NOT NULL
       ON CONFLICT (step_id, runner_id) DO UPDATE SET
         output_table_id = excluded.output_table_id, output_table_name = excluded.output_table_name,
         job_id = excluded.job_id, run_id = excluded.run_id, succeeded_at = excluded.succeeded_at`,
    ).run(runner?.accountId ?? null, output.id, output.name, runner?.jobId ?? null, runner?.runId ?? null,
      succeededAt, id, runner?.accountId ?? null);
  })();
}

/** One runner's latest recorded output of a step. */
export interface RunnerOutput {
  id: string;
  name: string;
  jobId: string | null;
  runId: string | null;
  succeededAt: string;
}

/**
 * The same runner's latest successful output of a step: a lookup by step and
 * runner, and nothing else. Another runner's output never answers it, and it
 * does not depend on the job or run that produced it still being kept.
 */
export function runnerOutput(stepId: string, runnerId: string, db: Database = metadataDb()): RunnerOutput | null {
  const row = db.prepare(`SELECT output_table_id AS id, output_table_name AS name, job_id AS jobId, run_id AS runId,
      succeeded_at AS succeededAt FROM step_runner_outputs WHERE step_id = ? AND runner_id = ?`)
    .get(stepId, runnerId) as RunnerOutput | undefined;
  return row ?? null;
}

/** Whether this runner's recorded output of the step is exactly this table:
 * the one question a rerun's replacement may ask, from stored state. */
export function runnerOwnsOutput(
  stepId: string,
  runnerId: string,
  table: { id: string; name: string },
  db: Database = metadataDb(),
): boolean {
  return db.prepare(`SELECT 1 FROM step_runner_outputs
    WHERE step_id = ? AND runner_id = ? AND output_table_id = ? AND output_table_name = ?`)
    .get(stepId, runnerId, table.id, table.name) !== undefined;
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

