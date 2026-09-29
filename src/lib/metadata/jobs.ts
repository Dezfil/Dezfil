import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { limits } from "@/lib/limits";
import type { ErrorCode } from "@/lib/api/errors";

/**
 * The operation run record.
 *
 * Two disciplines carry this module, and both come from what the tile record
 * cannot do.
 *
 * **A run is a row, not a slot.** The tile builder keeps one row per layer and
 * overwrites it on every transition, so a failed rebuild destroys the record of
 * the success before it. That is exactly the sentence a stale-and-failed step
 * has to say, so here every run appends its own row and no run ever writes over
 * another's.
 *
 * **Every terminal write is conditional, and that conditionality is the
 * authority check.** A job moves to a terminal state only from a non-terminal
 * one, expressed in the `WHERE` clause rather than in a prior read — so a
 * cancel racing a completion is decided by the database, once, instead of by
 * two callers who each looked before they leapt. `finish` returning false is
 * how the caller learns it lost the race, which is what stops a cancelled run
 * from publishing an output.
 */

export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Whether a job's identity is its own, or one its caller chose. */
/**
 * Who a run's subject belongs to.
 *
 * `client` is a grouping identity **any caller may send**, which is exactly why
 * `step` exists separately: a step's history is queried by kind as well as id,
 * so a caller who sends a step's id as their own subject groups their runs with
 * each other and never with the step's. Ownership was never taken from a
 * subject; this stops one being taken from a *history* either.
 */
export type SubjectKind = "run" | "client" | "step";

export const TERMINAL_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface OperationJob {
  id: string;
  subjectKind: SubjectKind;
  /** What groups runs into one history. A run with no caller-supplied
   * identity is its own subject, and this holds its own id. */
  subjectId: string;
  operation: string;
  parameters: Record<string, unknown> | null;
  state: JobState;
  /** Coded reason for a failure. Null for every other state — a cancelled
   * job carries none, because the user's own choice is not a fault. */
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  /** The registered dataset, present only once the run succeeded. */
  /**
   * Non-fatal facts a caller should read before trusting the answer — today,
   * that a measured input's WGS84 was assumed rather than declared.
   *
   * **In memory only, on the answer that accepts the run.** It is not a column:
   * the durable home for what a run assumed is the output's own provenance,
   * and a second copy on the job would be a second thing that can disagree. A
   * polled run therefore does not repeat it, and the output always carries it.
   */
  warnings?: string[];
  outputId: string | null;
  /** What a provider run asked, or null for a run whose answers came
   * from the engine. */
  disclosure?: unknown;
  outputName: string | null;
  acceptedAt: string;
  /** Absent until execution starts — a queued job has no start time and
   * must not claim one. */
  startedAt: string | null;
  finishedAt: string | null;
}

interface Row {
  id: string;
  subject_kind: SubjectKind;
  subject_id: string;
  operation: string;
  parameters: string | null;
  state: JobState;
  error_code: ErrorCode | null;
  error_message: string | null;
  output_id: string | null;
  disclosure?: string | null;
  output_name: string | null;
  accepted_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function hydrate(r: Row): OperationJob {
  return {
    id: r.id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    operation: r.operation,
    parameters: r.parameters ? (JSON.parse(r.parameters) as Record<string, unknown>) : null,
    state: r.state,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    outputId: r.output_id,
    ...(r.disclosure
      ? { disclosure: JSON.parse(r.disclosure) as unknown }
      : {}),
    outputName: r.output_name,
    acceptedAt: r.accepted_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function insertJob(scope: AccountScope, job: OperationJob, db: Database = metadataDb()): void {
  const ownerId = requireAccountScope(scope, db);
  db.prepare(
    `INSERT INTO operation_jobs
       (owner_id, id, subject_kind, subject_id, operation, parameters, state,
        error_code, error_message, output_id, output_name,
        accepted_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ownerId,
    job.id,
    job.subjectKind,
    job.subjectId,
    job.operation,
    job.parameters ? JSON.stringify(job.parameters) : null,
    job.state,
    job.errorCode,
    job.errorMessage,
    job.outputId,
    job.outputName,
    job.acceptedAt,
    job.startedAt,
    job.finishedAt,
  );
}

/** Remove a job row. Used only to undo a mint the lane then refused — a run
 * the server never took responsibility for must leave no record. */
export function deleteJob(id: string, db: Database = metadataDb()): boolean {
  return db.prepare(`DELETE FROM operation_jobs WHERE id = ?`).run(id).changes > 0;
}

export function getJob(id: string, db: Database = metadataDb()): OperationJob | null {
  const row = db
    .prepare(`SELECT * FROM operation_jobs WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? hydrate(row) : null;
}

export interface JobQuery {
  /** Narrow to one subject's runs — the history a "when did this last
   * succeed" question is asked of. */
  subjectId?: string;
  /** Narrow further to one kind, which is what makes a step's history its own:
   * `subjectId` alone is forgeable by any caller. */
  subjectKind?: SubjectKind;
  limit?: number;
}

/** Newest first, because a run history is read from its most recent end. */
export function listJobs(
  query: JobQuery = {},
  db: Database = metadataDb(),
): OperationJob[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.subjectId) {
    clauses.push("subject_id = ?");
    args.push(query.subjectId);
  }
  if (query.subjectKind) {
    clauses.push("subject_kind = ?");
    args.push(query.subjectKind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ``;
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
  const rows = db
    .prepare(
      // Ordered portably: `rowid` is SQLite's own and would not survive the
      // Postgres swap the repositories are kept ready for. The id breaks a
      // same-millisecond tie deterministically without borrowing engine
      // internals.
      `SELECT * FROM operation_jobs ${where}
       ORDER BY accepted_at DESC, id DESC LIMIT ${limit}`,
    )
    .all(...args) as Row[];
  return rows.map(hydrate);
}

/** Move a queued job into execution. False when it is no longer queued —
 * cancelled before it started, most usually. */
export function markRunning(
  id: string,
  startedAt: string,
  db: Database = metadataDb(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE operation_jobs SET state = 'running', started_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(startedAt, id).changes > 0
  );
}

export interface JobOutcome {
  state: Extract<JobState, "succeeded" | "failed" | "cancelled">;
  errorCode?: ErrorCode | null;
  errorMessage?: string | null;
  output?: { id: string; name: string } | null;
  /**
   * What a provider run asked, for the runs whose answers came off a wire.
   *
   * **Written on the job, in the same statement that settles it.** Reading it
   * from the output table instead made every older job report the newest run's
   * counts, because a step re-run replaces that output in place — and a
   * reclaimed name could attach an unrelated run's disclosure entirely. What a
   * run asked is a fact about the run.
   */
  disclosure?: unknown;
}

/**
 * Settle a job, but only from a non-terminal state.
 *
 * The `WHERE` clause is the whole point: it is the publication-authority check
 * the contract requires, made by the database rather than by a caller that
 * read the state a moment earlier. A run whose job was cancelled while it
 * worked gets `false` here, learns it has no authority, and must not register
 * its output. A terminal job is never rewritten, so a cancelled row cannot
 * later read as succeeded.
 */
export function finish(
  id: string,
  outcome: JobOutcome,
  finishedAt: string,
  db: Database = metadataDb(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE operation_jobs
         SET state = ?, error_code = ?, error_message = ?,
             output_id = ?, output_name = ?, finished_at = ?, disclosure = ?
         WHERE id = ? AND state IN ('queued', 'running')`,
      )
      .run(
        outcome.state,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.output?.id ?? null,
        outcome.output?.name ?? null,
        finishedAt,
        outcome.disclosure === undefined
          ? null
          : JSON.stringify(outcome.disclosure),
        id,
      ).changes > 0
  );
}

/** Every job a dead process left mid-flight. Queued and running are
 * both non-terminal and both need reconciling; they get different sentences
 * because only one of them was ever running. */
export function nonTerminalJobs(db: Database = metadataDb()): OperationJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM operation_jobs WHERE state IN ('queued', 'running')
       ORDER BY accepted_at`,
    )
    .all() as Row[];
  return rows.map(hydrate);
}

/**
 * Hold a subject's history to its configured depth.
 *
 * Two guards, and both exist because losing either would quietly defeat the
 * feature. **A queued or running job is never pruned** — it is live state the
 * lane is still answerable for, not history. And **the subject's most recent
 * success survives** even when it is older than the cap would keep, because
 * answering "when did this last succeed" after a run of failures is the single
 * thing this record exists for. The protected success counts *inside* the cap
 * rather than beside it, so the configured depth means one number.
 *
 * Returns how many rows were removed.
 */
export function pruneSubject(
  subjectId: string,
  cap: number = limits.operationHistoryPerSubject,
  db: Database = metadataDb(),
  /** Scoped by kind as well as id, so a caller who sends a step's id as their
   * own subject cannot evict that step's history by running enough of their
   * own. `subjectId` alone is forgeable. */
  subjectKind?: SubjectKind,
): number {
  const terminal = db
    .prepare(
      `SELECT id, state FROM operation_jobs
       WHERE subject_id = ? ${subjectKind ? "AND subject_kind = ?" : ""}
         AND state IN ('succeeded', 'failed', 'cancelled')
       ORDER BY accepted_at DESC, id DESC`,
    )
    .all(...(subjectKind ? [subjectId, subjectKind] : [subjectId])) as {
    id: string;
    state: JobState;
  }[];

  const keep = new Set(terminal.slice(0, cap).map((j) => j.id));
  const lastSuccess = terminal.find((j) => j.state === "succeeded");
  if (lastSuccess && !keep.has(lastSuccess.id)) {
    // Inside the cap, not beside it: the oldest otherwise-kept row makes way.
    const evictable = terminal
      .slice(0, cap)
      .filter((j) => j.state !== "succeeded")
      .at(-1);
    if (evictable) keep.delete(evictable.id);
    keep.add(lastSuccess.id);
  }

  const doomed = terminal.filter((j) => !keep.has(j.id)).map((j) => j.id);
  if (doomed.length === 0) return 0;
  const holes = doomed.map(() => "?").join(", ");
  return db
    .prepare(`DELETE FROM operation_jobs WHERE id IN (${holes})`)
    .run(...doomed).changes;
}
