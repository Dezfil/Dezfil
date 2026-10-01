import { requireOwnedTableReference } from "@/lib/metadata/owned-tables";
import { AuthError } from "@/lib/auth/errors";
import { failInactiveJob } from "@/lib/metadata/jobs";
import { admit, type RunRequest } from "./run-admission";
import { pruneAfterJob } from "./run-history";
export { admitOwned, type RunRequest } from "./run-admission";
export { prune, cancelRun, markAndSignalRunCancellation, pruneRunCancellation, waitForRunCancellation, type RunCancellation } from "./run-history";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import type { DataTable } from "@/lib/metadata/tables";
import {
  deleteJob,
  finish,
  insertJob,
  markRunning,
  type OperationJob,
} from "@/lib/metadata/owned-jobs";
import type {
  CompiledRun,
  PreparedPublication,
} from "./compile";
import { LostAuthority, materialize, type BoundInput } from "./materialize";
import * as lane from "./lane";

/**
 * Running an operation.
 *
 * The whole feature turns on one line being drawn in exactly one place: **the
 * admission boundary**. What can be known cheaply and certainly before any work
 * starts is refused immediately and mints no job; everything else is accepted
 * and reported on the job. Implementing half of that at the route and half
 * inside the run is how the halves drift, so it lives here, once.
 *
 * The second discipline is that a run's authority to publish is checked *inside*
 * the publication transaction rather than before it. A cancel racing a
 * completion is then decided by the database, and a cancelled run cannot leave
 * an output behind.
 */

function operationTimeout(): ApiError {
  return new ApiError(
    "operation_timeout",
    `The operation exceeded the ${Math.round(
      limits.operationTimeoutMs / 1000,
    )}s execution budget. Narrow it, or raise DEZFIL_OPERATION_TIMEOUT_S.`,
    408,
  );
}

/**
 * What else must commit with the job's own success.
 *
 * A plain run has nothing: the job settling *is* the publication. A recipe
 * step has its ownership and its lineage, and they land in the same
 * transaction or not at all.
 */
export type Publisher = (
  jobFinished: (db: Database, output: { id: string; name: string }) => boolean,
  /** The job whose success this publication commits. */
  jobId: string,
) => (
  table: { id: string; name: string },
  db: Database,
  inputs: BoundInput[],
) => boolean;

export interface SubmitOptions {
  operationId: string;
  /** The caller's parameters, recorded verbatim — never the reduction that
   * happened to be executable. */
  parameters: Record<string, unknown>;
  sql: string;
  name: string;
  /** Where this run measured, recorded in the output's provenance. */
  measurement?: Record<string, unknown>;
  /** Non-fatal facts to report on the answer that accepts the run. */
  warnings?: string[];
  /** The input generations the SQL was built for; re-checked before work. */
  bindings?: Record<string, string>;
  /**
   * Work that must happen before this run has a statement at all.
   *
   * It runs inside the job's own budget and signal, and what it produces — the
   * statement, the disclosure published in place of it, and the cleanup its
   * staging owes — is handed to the ordinary publication. That is the whole of
   * the generic idea: an operation may have work to do before its SQL runs.
   */
  prepare?: CompiledRun["prepare"];
  subject?: string;
  /** What the subject *is*. A caller-supplied one is `client`; a step's is
   * `step`, which no caller can send, so a step's history stays its own. */
  subjectKind?: OperationJob["subjectKind"];
  /** Replace this dataset's contents in place, keeping its id and name. Only
   * a caller that has proven ownership from stored state may pass one. */
  replaceTable?: { id: string; name: string };
  publisher?: Publisher;
  /** Preserve a contained attempt before the independent history cap. */
  onSettled?: (jobId: string) => void;
  /** Forwarded to the publication transaction. */
  onPublished?: (table: DataTable, db: Database) => void;
}

/** The work the lane runs for one job. It reports the job's own outcome and
 * never throws into the lane. */
function workFor(scope: AccountScope, job: OperationJob, options: SubmitOptions): lane.LaneWork {
  return async (signal: AbortSignal) => {
    // **One deadline over the whole run**, taken here — where the run starts
    // running, which is contract — rather than where publication begins. A
    // preparation that spends minutes leaves the publication what is left of
    // the budget, never a fresh one; otherwise a slow batch would get twice
    // the time it was promised and the coded timeout would arrive late.
    const deadlineAt = Date.now() + limits.operationTimeoutMs;

    let prepared: PreparedPublication | null = null;

    // **The disclosure settles with the job, in the same statement.** Reading
    // it back from the output table made an older run report a newer one's
    // counts, because a step re-run replaces that output in place. What this
    // run asked is a fact about this run.
    const jobFinished = (
      db: Database,
      output: { id: string; name: string },
    ): boolean =>
      finish(
        scope, job.id,
        {
          state: "succeeded",
          output,
          ...(prepared?.disclosure ? { disclosure: prepared.disclosure } : {}),
        },
        new Date().toISOString(),
        db,
      );

    try {
      // Check the durable owner before a queued job can contact a source.
      if (!markRunning(scope, job.id, new Date().toISOString())) return;
      if (options.prepare) {
        prepared = await options.prepare({
          signal,
          deadlineAt,
          timeoutError: operationTimeout,
        });
      }
      await materialize(scope, {
        sql: prepared ? prepared.sql : options.sql,
        ...(prepared?.inputs ? { inputs: prepared.inputs } : {}),
        name: options.name,
        operation: job.operation,
        parameters: job.parameters ?? {},
        ...(options.measurement ? { measurement: options.measurement } : {}),
        ...(prepared ? { disclosure: prepared.disclosure } : {}),
        signal,
        budgetMs: Math.max(1, deadlineAt - Date.now()),
        timeoutError: operationTimeout,
        ...(options.replaceTable ? { replaceTable: options.replaceTable } : {}),
        ...(options.bindings ? { requireBindings: options.bindings } : {}),
        // The authority check, inside the publication transaction.
        authorize: options.publisher
          ? options.publisher(jobFinished, job.id)
          : (table, db) => jobFinished(db, { id: table.id, name: table.name }),
        ...(options.onPublished ? { onPublished: options.onPublished } : {}),
      });
    } catch (error) {
      settleFailure(scope, job, error);
    } finally {
      // **Whatever happened.** The staging a preparation owns is removed on
      // success, failure, cancellation and timeout alike — the boot sweep is
      // the backstop for a process that dies, not the ordinary path.
      if (prepared) await prepared.cleanup().catch(() => {});
      try { options.onSettled?.(job.id); }
      catch (error) { console.warn(`[operations] run ${job.id} could not retain its attempt:`, error); }
      pruneAfterJob(job.id);
    }
  };
}

/**
 * Mint the job and hand the work to the lane.
 *
 * Shared by every path that runs something, so a step's run and a one-off run
 * cannot drift in how they are recorded, cancelled or recovered.
 */
export function submitRun(scope: AccountScope, options: SubmitOptions): OperationJob {
  requireAccountScope(scope);
  if (options.replaceTable) requireOwnedTableReference(scope, options.replaceTable);
  const id = randomUUID();
  const job: OperationJob = {
    id,
    subjectKind: options.subjectKind ?? (options.subject ? "client" : "run"),
    subjectId: options.subject ?? id,
    operation: options.operationId,
    parameters: options.parameters,
    state: "queued",
    errorCode: null,
    errorMessage: null,
    outputId: null,
    outputName: null,
    acceptedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...(options.warnings?.length ? { warnings: options.warnings } : {}),
  };

  // Order matters, and getting it wrong is silent: the lane pumps
  // synchronously, so the work's first act — claiming the job as running —
  // happens inside `submit`. The row has to exist by then or that claim finds
  // nothing, returns false, and the run sits queued forever having quietly
  // done nothing.
  insertJob(scope, job);
  try {
    lane.submit(id, workFor(scope, job, options));
  } catch (error) {
    // The lane refused it, so the server never took responsibility for this
    // work and must leave no record of it.
    deleteJob(scope, id);
    throw error;
  }
  return job;
}

function settleFailure(scope: AccountScope, job: OperationJob, error: unknown): void {
  if (failInactiveJob(job.id)) return;
  // The run lost its claim (E10's fence). Who took it away decides how this
  // settles, and the *job's own row* is the honest way to ask: a cancel wrote
  // `cancelled` before it signalled, so the row is already terminal and
  // writing another outcome would be the product arguing with itself. A step
  // deleted, superseded, or its recipe deleted writes nothing on the job —
  // nobody did — and leaving it non-terminal would strand a run as watchably
  // active forever. So it settles here, failed, with the code G6 approved
  // rather than a sixth state.
  if (error instanceof LostAuthority) {
    finish(
      scope, job.id,
      {
        state: "failed",
        errorCode: "operation_superseded",
        errorMessage:
          `The step this run belonged to was changed or removed while it was ` +
          `working, so it published nothing.`,
      },
      new Date().toISOString(),
    );
    return;
  }
  // A cancellation the boundary raised — same story, the cancel path owns it.
  if (error instanceof EvaluationCancelled) return;

  const now = new Date().toISOString();
  if (error instanceof ApiError || error instanceof AuthError) {
    finish(
      scope, job.id,
      { state: "failed", errorCode: error.code, errorMessage: error.message },
      now,
    );
    return;
  }
  console.error(`[operations] run ${job.id} failed:`, error);
  finish(
    scope, job.id,
    {
      state: "failed",
      errorCode: "internal",
      errorMessage: "An unexpected server error occurred.",
    },
    now,
  );
}

/**
 * Admit a run and hand it to the lane.
 *
 * Answers as soon as the job exists, which is the whole point: the caller holds
 * an identity, not a result, and the work is no longer tied to their request.
 */
export async function startRun(scope: AccountScope, request: RunRequest): Promise<OperationJob> {
  requireAccountScope(scope);
  // No `owns` argument: a one-off run never holds the admission exception, so
  // a caller cannot reach it by imitating a step.
  const admitted = await admit(scope, request);
  return submitRun(scope, {
    operationId: admitted.operationId,
    parameters: request.parameters ?? {},
    sql: admitted.sql,
    name: admitted.name,
    ...(admitted.measurement ? { measurement: admitted.measurement } : {}),
    ...(admitted.warnings ? { warnings: admitted.warnings } : {}),
    ...(admitted.bindings ? { bindings: admitted.bindings } : {}),
    ...(admitted.prepare ? { prepare: admitted.prepare } : {}),
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
  });
}
