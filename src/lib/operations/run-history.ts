import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { finish, getJob, requireJob, type OperationJob } from "@/lib/metadata/owned-jobs";
import { finish as finishJob, isTerminal, pruneSubject, pruneJobHistory } from "@/lib/metadata/jobs";
import { getCascadeJob } from "@/lib/metadata/cascades";
import * as lane from "./lane";

/**
 * Hold a subject's history to its cap, from every path that settles a run.
 *
 * Pruning only from the lane's work would miss the terminal transitions that
 * never reach it — a queued run cancelled before it starts, and every run
 * startup recovery settles — so a subject cancelled repeatedly would grow past
 * its documented depth. A stumble here is logged and never turned into a
 * failure answer for a run that already finished.
 */
export function prune(scope: AccountScope, subjectId: string, subjectKind?: OperationJob["subjectKind"]): void {
  requireAccountScope(scope);
  try {
    pruneSubject(scope, subjectId, undefined, undefined, subjectKind);
  } catch (error) {
    console.warn(
      `history pruning failed for subject "${subjectId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface RunCancellation {
  job: OperationJob;
  wasTerminal: boolean;
  settled: Promise<void>;
  /** The job as it now stands, read the way it was found. */
  reread: () => OperationJob | null;
  /** The subject-history cap the cancellation owes. */
  prune: () => void;
}

/** Mark first, then signal. The mark is what removes the run's authority to
 * publish, so a run that finishes during the signal still cannot commit —
 * this ordering closes the race and is not incidental. */
function markAndSignal(job: OperationJob, mark: () => void, reread: () => OperationJob | null,
  prune: () => void): RunCancellation {
  if (isTerminal(job.state)) {
    return { job, wasTerminal: true, settled: Promise.resolve(), reread, prune };
  }
  mark();
  lane.cancel(job.id);
  const marked = reread() ?? { ...job, state: "cancelled" as const };
  const settled = Promise.race([
    lane.jobSettled(job.id),
    new Promise<void>((resolve) => setTimeout(resolve, CANCEL_SETTLE_GRACE_MS)),
  ]);
  return { job: marked, wasTerminal: false, settled, reread, prune };
}

/** Raise the publication fence and signal the lane, without waiting or pruning. */
export function markAndSignalRunCancellation(scope: AccountScope, jobId: string): RunCancellation {
  const job = requireJob(scope, jobId);
  return markAndSignal(job,
    () => { finish(scope, jobId, { state: "cancelled" }, new Date().toISOString()); },
    () => getJob(scope, jobId),
    () => prune(scope, job.subjectId, job.subjectKind));
}

/**
 * The same, for a member of a workflow run, acting on the job through the run
 * rather than through the canceller's own jobs: the job is the run
 * initiator's, and the run's initiator and its workflow's owner may both stop
 * it. The caller has already been authorized to cancel the run.
 */
export function markAndSignalMemberCancellation(cascadeId: string, jobId: string): RunCancellation {
  const job = getCascadeJob(cascadeId, jobId);
  if (!job) throw new Error(`Run ${cascadeId} holds no job ${jobId}.`);
  return markAndSignal(job,
    () => { finishJob(jobId, { state: "cancelled" }, new Date().toISOString()); },
    () => getCascadeJob(cascadeId, jobId),
    () => pruneAfterJob(jobId));
}

/** Apply the ordinary subject-history cap after a cancellation mark. */
export function pruneRunCancellation(cancellation: RunCancellation): void {
  if (!cancellation.wasTerminal) cancellation.prune();
}

/** Wait within the existing engine-settlement budget, without pruning. */
export async function waitForRunCancellation(
  cancellation: RunCancellation,
): Promise<OperationJob> {
  await cancellation.settled;
  return cancellation.reread() ?? cancellation.job;
}

/**
 * Stop a run.
 *
 * Terminal is not an error (G5): cancel means *make sure this is not running*,
 * and for a job that already finished that is true. Answering a conflict would
 * turn the commonest race — cancel clicked as the run lands — into a failure
 * where nothing went wrong.
 */
export async function cancelRun(scope: AccountScope, jobId: string): Promise<OperationJob> {
  const cancellation = markAndSignalRunCancellation(scope, jobId);
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

/** Maintenance follows a recorded job, never an untrusted subject or owner. */
export function pruneAfterJob(id: string): void {
  try { pruneJobHistory(id); }
  catch (error) { console.warn(`history pruning failed for run "${id}": ${error instanceof Error ? error.message : String(error)}`); }
}
