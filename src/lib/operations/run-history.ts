import { ApiError } from "@/lib/api/errors";
import { finish, getJob, isTerminal, pruneSubject, type OperationJob } from "@/lib/metadata/jobs";
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
