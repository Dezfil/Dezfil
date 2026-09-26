import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { boundedEvaluation } from "@/lib/query/bounded";
import { assertReadOnlySelect } from "@/lib/query/guard";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import { deriveTableName } from "@/lib/ingest/naming";
import {
  deleteJob,
  finish,
  getJob,
  insertJob,
  markRunning,
  pruneSubject,
  isTerminal,
  type OperationJob,
} from "@/lib/metadata/jobs";
import {
  compileOperation,
  type CompiledRun,
  type PreparedPublication,
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

export interface RunRequest {
  operation: string;
  parameters: Record<string, unknown>;
  /**
   * What groups this run with others in history. A caller may supply one —
   * steps will supply their step id — and runs sharing it are one subject.
   * Omitted, the run is its own subject, which is honest for a one-off and
   * keeps history complete either way.
   */
  subject?: string;
}

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
 * Everything refused before a job exists.
 *
 * Each of these is knowable without running the operation, so answering
 * immediately is both cheaper and more useful than a job that was doomed when
 * it was minted. Compiling the verb is part of that: a spatial join naming an
 * input that does not exist, or an aggregate a column cannot take, is refused
 * here rather than becoming a job that was doomed when it was minted.
 *
 * **`owns` is the one narrow amendment to that boundary**. A run may be
 * admitted for a name that is already taken **only** when the caller has
 * already proven, from stored state, that it owns exactly that table. It is
 * never derived from anything in the request — `subject` is a grouping identity
 * any client may send, and reading it as authorization would let any caller
 * overwrite any table.
 */
async function admit(
  request: RunRequest,
  owns?: { id: string; name: string },
): Promise<{
  sql: string;
  name: string;
  operationId: string;
  measurement?: Record<string, unknown>;
  warnings?: string[];
  bindings?: Record<string, string>;
  prepare?: CompiledRun["prepare"];
}> {
  const params = request.parameters ?? {};
  const { sql, name, measurement, bindings, prepare, assumedCrs: ownRoute } = await compileOperation(
    request.operation,
    params,
  );

  // An empty subject is refused rather than quietly treated as absent: it
  // would be stored as a shared identity that groups unrelated runs, while
  // reading as self-owned and being unfilterable — three disagreements from
  // one falsy value.
  if (
    request.subject !== undefined &&
    (typeof request.subject !== "string" || request.subject.trim() === "")
  ) {
    throw new ApiError(
      "invalid_request",
      `"subject" must be a non-empty string when given.`,
      400,
    );
  }
  // Against the name the registry will actually use, not the one typed. The
  // materializer sanitizes into a SQL identifier, so "Bus Stops" becomes
  // "bus_stops" — checking the raw text here would miss a real collision, and
  // the run would be accepted only to fail at its commit, which is precisely
  // the wrong side of the admission boundary.
  const registered = deriveTableName(name, new Set());
  const existing = getTableByName(registered);
  if (existing && !(owns && owns.id === existing.id && owns.name === existing.name)) {
    throw new ApiError(
      "name_taken",
      `A table named "${name}" already exists. An operation never replaces or ` +
        `renames around an existing table. Choose another name.`,
      409,
    );
  }
  // Not a read-only SELECT: the guard's refusal, before anything is minted.
  //
  // **A prepared run has no statement yet**: its SQL names a staging path that
  // does not exist until the preparation has written it, so there is nothing
  // here to classify. The statement the preparation returns goes through the
  // same guard inside the materializer, which is where every run's SQL is
  // checked in any case — so this skips a check that cannot run, not one that
  // matters.
  if (!prepare) {
    await boundedEvaluation(async (conn) => assertReadOnlySelect(conn, sql));
  }

  // The assumed-CRS observation, said **before the run**: a metric answer over data whose WGS84 was guessed is still
  // computed, and the caller is told rather than refused. Either road: the
  // measurement record where one exists, the compiled run's own field
  // where the verb makes no measurement.
  const assumed = measurement?.assumedCrs ?? ownRoute ?? [];
  return {
    sql,
    name,
    operationId: request.operation,
    ...(measurement ? { measurement: measurement as unknown as Record<string, unknown> } : {}),
    ...(bindings ? { bindings } : {}),
    ...(prepare ? { prepare } : {}),
    ...(assumed.length
      ? {
          warnings: [
            `${assumed.map((n) => `"${n}"`).join(", ")} ${
              assumed.length === 1 ? "was" : "were"
            } imported without a declared coordinate system, so WGS84 was ` +
              // K7b: a verb with no measurement record must not call its
              // answer one — the warning is about trusting coordinates.
              `assumed. ${measurement ? "This measurement" : "The result"} is ` +
              `only as trustworthy as that assumption, and the output ` +
              `records it.`,
          ],
        }
      : {}),
  };
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
  /** Forwarded to the publication transaction. */
  onPublished?: (table: DataTable, db: Database) => void;
}

/** The work the lane runs for one job. It reports the job's own outcome and
 * never throws into the lane. */
function workFor(job: OperationJob, options: SubmitOptions): lane.LaneWork {
  return async (signal: AbortSignal) => {
    // Cancelled between admission and its turn: it never starts.
    if (!markRunning(job.id, new Date().toISOString())) return;

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
        job.id,
        {
          state: "succeeded",
          output,
          ...(prepared?.disclosure ? { disclosure: prepared.disclosure } : {}),
        },
        new Date().toISOString(),
        db,
      );

    try {
      if (options.prepare) {
        prepared = await options.prepare({
          signal,
          deadlineAt,
          timeoutError: operationTimeout,
        });
      }
      await materialize({
        sql: prepared ? prepared.sql : options.sql,
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
          ? options.publisher(jobFinished)
          : (table, db) => jobFinished(db, { id: table.id, name: table.name }),
        ...(options.onPublished ? { onPublished: options.onPublished } : {}),
      });
    } catch (error) {
      settleFailure(job, error);
    } finally {
      // **Whatever happened.** The staging a preparation owns is removed on
      // success, failure, cancellation and timeout alike — the boot sweep is
      // the backstop for a process that dies, not the ordinary path.
      if (prepared) await prepared.cleanup().catch(() => {});
      prune(job.subjectId, job.subjectKind);
    }
  };
}

/**
 * Mint the job and hand the work to the lane.
 *
 * Shared by every path that runs something, so a step's run and a one-off run
 * cannot drift in how they are recorded, cancelled or recovered.
 */
export function submitRun(options: SubmitOptions): OperationJob {
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
  insertJob(job);
  try {
    lane.submit(id, workFor(job, options));
  } catch (error) {
    // The lane refused it, so the server never took responsibility for this
    // work and must leave no record of it.
    deleteJob(id);
    throw error;
  }
  return job;
}

/**
 * Hold a subject's history to its cap, from every path that settles a run.
 *
 * Pruning only from the lane's work would miss the terminal transitions that
 * never reach it — a queued run cancelled before it starts, and every run
 * startup recovery settles — so a subject cancelled repeatedly would grow past
 * its documented depth. A stumble here is logged and never turned into a
 * failure answer for a run that already finished.
 */
export function prune(subjectId: string, subjectKind?: OperationJob["subjectKind"]): void {
  try {
    pruneSubject(subjectId, undefined, undefined, subjectKind);
  } catch (error) {
    console.warn(
      `history pruning failed for subject "${subjectId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function settleFailure(job: OperationJob, error: unknown): void {
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
      job.id,
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
  if (error instanceof ApiError) {
    finish(
      job.id,
      { state: "failed", errorCode: error.code, errorMessage: error.message },
      now,
    );
    return;
  }
  console.error(`[operations] run ${job.id} failed:`, error);
  finish(
    job.id,
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
export async function startRun(request: RunRequest): Promise<OperationJob> {
  // No `owns` argument: a one-off run never holds the admission exception, so
  // a caller cannot reach it by imitating a step.
  const admitted = await admit(request);
  return submitRun({
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

/** Admit a run that a caller has already proven owns the name it reuses. */
export async function admitOwned(
  request: RunRequest,
  owns: { id: string; name: string } | undefined,
) {
  return admit(request, owns);
}

export interface RunCancellation {
  job: OperationJob;
  wasTerminal: boolean;
  settled: Promise<void>;
}

/** Raise the publication fence and signal the lane, without waiting or pruning. */
export function markAndSignalRunCancellation(jobId: string): RunCancellation {
  const job = getJob(jobId);
  if (!job) {
    throw new ApiError("not_found", `No run with id "${jobId}".`, 404);
  }
  if (isTerminal(job.state)) {
    return { job, wasTerminal: true, settled: Promise.resolve() };
  }

  // Mark first, then signal. The mark is what removes the run's authority to
  // publish, so a run that finishes during the signal still cannot commit —
  // this ordering closes the race and is not incidental.
  finish(jobId, { state: "cancelled" }, new Date().toISOString());
  lane.cancel(jobId);
  const marked = getJob(jobId) ?? { ...job, state: "cancelled" as const };
  const settled = Promise.race([
    lane.jobSettled(jobId),
    new Promise<void>((resolve) => setTimeout(resolve, CANCEL_SETTLE_GRACE_MS)),
  ]);
  return { job: marked, wasTerminal: false, settled };
}

/** Apply the ordinary subject-history cap after a cancellation mark. */
export function pruneRunCancellation(cancellation: RunCancellation): void {
  if (!cancellation.wasTerminal) {
    prune(cancellation.job.subjectId, cancellation.job.subjectKind);
  }
}

/** Wait within the existing engine-settlement budget, without pruning. */
export async function waitForRunCancellation(
  cancellation: RunCancellation,
): Promise<OperationJob> {
  await cancellation.settled;
  return getJob(cancellation.job.id) ?? cancellation.job;
}

/**
 * Stop a run.
 *
 * Terminal is not an error (G5): cancel means *make sure this is not running*,
 * and for a job that already finished that is true. Answering a conflict would
 * turn the commonest race — cancel clicked as the run lands — into a failure
 * where nothing went wrong.
 */
export async function cancelRun(jobId: string): Promise<OperationJob> {
  const cancellation = markAndSignalRunCancellation(jobId);
  if (cancellation.wasTerminal) return cancellation.job;

  // Preserve the ordinary single-job road: its history is capped as soon as
  // the terminal mark lands. Cascade cancellation uses the callable boundary
  // to keep its own member attempt before invoking this same prune phase.
  pruneRunCancellation(cancellation);

  // Then wait for the engine to actually let go before reporting terminal.
  // Marking is immediate because it fences publication; *saying* the run has
  // stopped while its statement is still winding down would be the same
  // bookkeeping-instead-of-truth this spec refuses elsewhere. The wait is
  // bounded so a statement that will not yield cannot hold the response.
  return waitForRunCancellation(cancellation);
}

/** How long a cancel waits for the engine to let go before answering anyway. */
const CANCEL_SETTLE_GRACE_MS = 10_000;
