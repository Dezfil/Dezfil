import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { metadataDb } from "./db";
import { getJob, type JobState, type OperationJob } from "./jobs";

/**
 * A cascade's durable record.
 *
 * **A cascade is not a job, and this is why it has its own table.** job
 * contract says a succeeded job names exactly one output dataset. A cascade may
 * produce several, or none, and may end with some members succeeded and others
 * never attempted — forcing that into the job contract would either break it or
 * invent a sixth state. So a cascade *contains* jobs rather than being one, and
 * its members' jobs stay ordinary jobs in the five states.
 *
 * **`not_run` is a member's condition, never a job state.** A step whose
 * dependency failed mints no job at all; what records it is a member row saying
 * so, and naming what stopped it.
 *
 * **Cancellation is persisted, not a flag in a loop.** A cancelled cascade must
 * stop admitting members while it is still interrupting the one that is
 * running, and that decision is read from two places. A planner checking a
 * variable between submissions would admit the next member during the
 * interrupt; the fence is a column for exactly that reason.
 */

/** Where a cascade started: the whole recipe, or one step and its dependents. */
/** `single` is a node's own run: one member, no dependents,
 * a workflow run like the others — listed, read and cancelled as one. */
export type CascadeKind = "run_all" | "from_step" | "single";

export type CascadeOutcome =
  | "completed"
  | "partly_completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * A member's state within the cascade.
 *
 * `not_run` is the one that does not correspond to a job: it means the member
 * was never attempted, because something it depends on failed or because the
 * cascade was cancelled before its turn.
 */
export type MemberState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "not_run";

/**
 * What became of a member's attempt: the job's state, error, times and
 * output, composed from the live job while it is in flight and kept as a
 * snapshot on the member once it settles, so the run reads whole after the
 * job is pruned. A member never attempted has none.
 */
export interface MemberAttempt {
  state: JobState;
  error: { code: string; message: string } | null;
  acceptedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: { id: string; name: string } | null;
}

/** A member as the plan records it: what the node is and what it is
 * called, so the run names it after the node is removed. */
export interface MemberIdentity {
  stepId: string;
  ordinal: number;
  operation?: string;
  name?: string | null;
}

export interface CascadeMember {
  stepId: string;
  ordinal: number;
  operation: string | null;
  name: string | null;
  state: MemberState;
  /** The job this member's attempt minted; null when it never attempted one. */
  jobId: string | null;
  /** What stopped it — a failed member's step id, or a coded reason. */
  stoppedBy: string | null;
  /** The server's sentence for that stop, where one exists. `stoppedBy`
   * is a code, a blocking step id or "cancelled"; none of those names which
   * table is gone. */
  stoppedReason: string | null;
  /**
   * The dataset this member published, recorded here rather than read back
   * from its job.
   *
   * Job history is capped per subject, so a cascade that named its outputs by
   * walking its members' jobs quietly lost them once the steps had been re-run
   * enough times — a durable result forgetting half of itself while its own row
   * stayed. The cascade records what it saw when it saw it.
   */
  output: { id: string; name: string } | null;
  attempt: MemberAttempt | null;
}

export interface CascadeRun {
  id: string;
  recipeId: string;
  kind: CascadeKind;
  outcome: CascadeOutcome | null;
  cancelled: boolean;
  startedAt: string;
  finishedAt: string | null;
  members: CascadeMember[];
}

interface RunRow {
  id: string;
  recipe_id: string;
  kind: CascadeKind;
  outcome: CascadeOutcome | null;
  cancelled: number;
  started_at: string;
  finished_at: string | null;
}

interface MemberRow {
  cascade_id: string;
  step_id: string;
  ordinal: number;
  state: MemberState;
  job_id: string | null;
  stopped_by: string | null;
  stopped_reason: string | null;
  output_table_id: string | null;
  output_table_name: string | null;
  operation: string | null;
  node_name: string | null;
  attempt_state: JobState | null;
  attempt_error_code: string | null;
  attempt_error_message: string | null;
  attempt_accepted_at: string | null;
  attempt_started_at: string | null;
  attempt_finished_at: string | null;
}

/** The attempt as the job says it, for a member whose job is still readable. */
export function attemptOf(job: OperationJob): MemberAttempt {
  return {
    state: job.state,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage ?? "The run failed." } : null,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    output: job.outputId && job.outputName ? { id: job.outputId, name: job.outputName } : null,
  };
}

function attemptFromRow(m: MemberRow, db: Database): MemberAttempt | null {
  // The snapshot, once taken, is the record; before that the live job is —
  // it says queued or running, which the member's own state cannot.
  if (m.attempt_state && m.attempt_accepted_at) {
    return {
      state: m.attempt_state,
      error: m.attempt_error_code
        ? { code: m.attempt_error_code, message: m.attempt_error_message ?? "The run failed." }
        : null,
      acceptedAt: m.attempt_accepted_at,
      startedAt: m.attempt_started_at,
      finishedAt: m.attempt_finished_at,
      output: m.output_table_id && m.output_table_name ? { id: m.output_table_id, name: m.output_table_name } : null,
    };
  }
  if (!m.job_id) return null;
  const job = getCascadeJob(m.cascade_id, m.job_id, db);
  return job ? attemptOf(job) : null;
}

function hydrate(row: RunRow, members: MemberRow[], db: Database): CascadeRun {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    kind: row.kind,
    outcome: row.outcome,
    cancelled: row.cancelled === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    members: members.map((m) => ({
      stepId: m.step_id,
      ordinal: m.ordinal,
      operation: m.operation,
      name: m.node_name,
      state: m.state,
      jobId: m.job_id,
      stoppedBy: m.stopped_by,
      stoppedReason: m.stopped_reason,
      output:
        m.output_table_id && m.output_table_name
          ? { id: m.output_table_id, name: m.output_table_name }
          : null,
      attempt: attemptFromRow(m, db),
    })),
  };
}

/** Record a run. `initiatorId` is the account that started it; a record
 * made without one takes the workflow's owner, the only account that could
 * start a run before runs had initiators. */
export function createCascade(
  recipeId: string,
  kind: CascadeKind,
  members: MemberIdentity[],
  db: Database = metadataDb(),
  initiatorId: string | null = null,
): CascadeRun {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO cascade_runs (id, recipe_id, kind, outcome, cancelled, started_at, finished_at, initiator_id)
       VALUES (?, ?, ?, NULL, 0, ?, NULL, ?)`,
    ).run(id, recipeId, kind, startedAt, initiatorId);
    const stmt = db.prepare(
      `INSERT INTO cascade_members (cascade_id, step_id, ordinal, state, job_id, stopped_by, operation, node_name)
       VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    );
    for (const m of members) stmt.run(id, m.stepId, m.ordinal, m.operation ?? null, m.name ?? null);
  })();
  return getCascade(id, db)!;
}

export function getCascade(
  id: string,
  db: Database = metadataDb(),
): CascadeRun | null {
  const row = db.prepare(`SELECT * FROM cascade_runs WHERE id = ?`).get(id) as
    | RunRow
    | undefined;
  if (!row) return null;
  const members = db
    .prepare(`SELECT * FROM cascade_members WHERE cascade_id = ? ORDER BY ordinal`)
    .all(id) as MemberRow[];
  return hydrate(row, members, db);
}

export function listCascades(
  recipeId?: string,
  db: Database = metadataDb(),
): CascadeRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM cascade_runs ${recipeId ? "WHERE recipe_id = ?" : ""}
       ORDER BY started_at DESC, id DESC LIMIT 100`,
    )
    .all(...(recipeId ? [recipeId] : [])) as RunRow[];
  return rows.map((r) => getCascade(r.id, db)!);
}

export function setMember(
  cascadeId: string,
  stepId: string,
  update: {
    state: MemberState;
    jobId?: string | null;
    stoppedBy?: string | null;
    stoppedReason?: string | null;
    output?: { id: string; name: string } | null;
  },
  db: Database = metadataDb(),
): void {
  db.prepare(
    `UPDATE cascade_members
     SET state = ?,
         job_id = COALESCE(?, job_id),
         stopped_by = COALESCE(?, stopped_by),
         stopped_reason = COALESCE(?, stopped_reason),
         output_table_id = COALESCE(?, output_table_id),
         output_table_name = COALESCE(?, output_table_name)
     WHERE cascade_id = ? AND step_id = ?`,
  ).run(
    update.state,
    update.jobId ?? null,
    update.stoppedBy ?? null,
    update.stoppedReason ?? null,
    update.output?.id ?? null,
    update.output?.name ?? null,
    cascadeId,
    stepId,
  );
}

/**
 * Raise the cancellation fence.
 *
 * Durable and idempotent, and deliberately separate from settling the outcome:
 * the fence must already be up while the running member is still being
 * interrupted, so that nothing else is admitted in the meantime.
 */
/** Keep the member's attempt with the run: copied from the job when the
 * member settles, so the run still says what happened after the job goes. */
export function snapshotAttempt(
  cascadeId: string,
  stepId: string,
  job: OperationJob,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `UPDATE cascade_members
     SET job_id = COALESCE(job_id, ?), attempt_state = ?, attempt_error_code = ?, attempt_error_message = ?,
         attempt_accepted_at = ?, attempt_started_at = ?, attempt_finished_at = ?,
         output_table_id = COALESCE(output_table_id, ?),
         output_table_name = COALESCE(output_table_name, ?)
     WHERE cascade_id = ? AND step_id = ?`,
  ).run(
    job.id,
    job.state,
    job.errorCode ?? null,
    job.errorMessage ?? null,
    job.acceptedAt,
    job.startedAt,
    job.finishedAt,
    job.outputId,
    job.outputName,
    cascadeId,
    stepId,
  );
}

export function raiseCancelFence(id: string, db: Database = metadataDb()): boolean {
  return (
    db
      .prepare(`UPDATE cascade_runs SET cancelled = 1 WHERE id = ? AND outcome IS NULL`)
      .run(id).changes > 0
  );
}

/** Read the fence from durable state, never from a variable a loop closed over. */
export function isCancelled(id: string, db: Database = metadataDb()): boolean {
  const row = db.prepare(`SELECT cancelled FROM cascade_runs WHERE id = ?`).get(id) as
    | { cancelled: number }
    | undefined;
  return row?.cancelled === 1;
}

/** Settle a cascade, only from a non-terminal state — the same discipline
 * applies to a job, so a cancelled cascade cannot later read completed. */
export function finishCascade(
  id: string,
  outcome: CascadeOutcome,
  finishedAt: string,
  db: Database = metadataDb(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE cascade_runs SET outcome = ?, finished_at = ?
         WHERE id = ? AND outcome IS NULL`,
      )
      .run(outcome, finishedAt, id).changes > 0
  );
}

/** Cascades still claiming to be active — what a restart has to settle. */
/** A run recorded and then refused before anything was attempted leaves
 * nothing behind: the row goes, its members with it. */
export function deleteCascade(id: string, db: Database = metadataDb()): void {
  db.prepare(`DELETE FROM cascade_runs WHERE id = ?`).run(id);
}

/** The workflow's run in flight, if any: one at a time. */
export function activeCascade(recipeId: string, db: Database = metadataDb()): CascadeRun | null {
  const row = db
    .prepare(`SELECT * FROM cascade_runs WHERE recipe_id = ? AND outcome IS NULL ORDER BY started_at DESC LIMIT 1`)
    .get(recipeId) as RunRow | undefined;
  return row ? getCascade(row.id, db) : null;
}

export function nonTerminalCascades(db: Database = metadataDb()): CascadeRun[] {
  const rows = db
    .prepare(`SELECT * FROM cascade_runs WHERE outcome IS NULL`)
    .all() as RunRow[];
  return rows.map((r) => getCascade(r.id, db)!);
}

/** Internal reconciliation reads only jobs belonging to the durable parent:
 * the jobs of the run's initiator (the workflow's owner for a run recorded
 * before runs had initiators), including inactive initiators and pending
 * legacy adoption. It grants no API access. */
export function getCascadeJob(cascadeId: string, jobId: string, db: Database = metadataDb()) {
  const own = db.prepare(`SELECT j.id FROM operation_jobs j
    JOIN cascade_runs c ON c.id = ? JOIN recipes r ON r.id = c.recipe_id
    WHERE j.id = ? AND (j.owner_id = COALESCE(c.initiator_id, r.owner_id)
      OR (j.owner_id IS NULL AND COALESCE(c.initiator_id, r.owner_id) IS NULL))`)
    .get(cascadeId, jobId);
  return own ? getJob(jobId, db) : null;
}

/** A finished worker keeps its own attempt before independent job pruning.
 * The durable job must be the run initiator's, for the member's step. */
export function archiveCascadeAttempt(cascadeId: string, stepId: string, jobId: string, db: Database = metadataDb()) {
  const job = getCascadeJob(cascadeId, jobId, db);
  if (!job || job.subjectKind !== "step" || job.subjectId !== stepId) return;
  if (!db.prepare(`SELECT step_id FROM cascade_members WHERE cascade_id = ? AND step_id = ?
    AND (job_id IS NULL OR job_id = ?)`).get(cascadeId, stepId, jobId)) return;
  snapshotAttempt(cascadeId, stepId, job, db);
}
