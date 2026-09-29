import {
  finishCascade,
  nonTerminalCascades,
  setMember,
  snapshotAttempt,
} from "@/lib/metadata/cascades";
import { finish, getJob, nonTerminalJobs } from "@/lib/metadata/jobs";
import { pruneAfterJob } from "./run-history";

/**
 * Startup reconciliation for the run lane.
 *
 * The lane is in-process: when the process dies, every run it was executing
 * dies with it, but the *record* survives in durable metadata still claiming to
 * be queued or running. A job that says running when nothing is running is the
 * product not knowing its own state, so every non-terminal row is settled here,
 * before anything can read it.
 *
 * **Nothing is re-executed.** A restarted server does not silently repeat
 * expensive work a second time; the user is told what happened and re-runs if
 * they want it.
 *
 * **Nothing committed is deleted.** A run that had already published its
 * dataset also published its success in the same transaction, so it is terminal
 * already and never reaches this sweep. That is why recovery can be a pure
 * marking pass: the indivisibility of publication is what removes the
 * half-published state it would otherwise have to repair.
 *
 * **The reason is true of the job it describes.** A run that was executing is
 * told the server stopped while it ran; one that never left the queue is told it
 * never started. One sentence covering both would be false for one of them, and
 * a record that misdescribes what happened is worse than a terse one.
 */
export function recoverInterruptedRuns(): number {
  const stranded = nonTerminalJobs();
  if (stranded.length === 0) return 0;

  const now = new Date().toISOString();
  let settled = 0;
  for (const job of stranded) {
    const message =
      job.state === "running"
        ? "The server stopped while this run was executing, so it did not " +
          "finish. Nothing partial was kept; run it again."
        : "The server stopped before this run started, so it never ran. " +
          "Run it again.";
    if (
      finish(
        job.id,
        { state: "failed", errorCode: "operation_interrupted", errorMessage: message },
        now,
      )
    ) {
      settled += 1;
      // This is a terminal transition like any other, so it owes the subject's
      // history the same cap. Recovery settling a burst of stranded runs is
      // exactly when a subject would otherwise grow past its documented depth.
      pruneAfterJob(job.id);
    }
  }
  console.warn(
    `boot: settled ${settled} operation run(s) left in flight by a stopped process`,
  );
  return settled;
}

/**
 * The same reconciliation, one level up.
 *
 * **A cascade always reaches a terminal outcome.** Its drive loop is in-process
 * exactly as the lane is, so a stopped process leaves a record still claiming to
 * be active — and unlike a job, nothing else would ever settle it. It becomes
 * `interrupted`, which is its own outcome rather than a failure: what happened
 * is not that its members went wrong but that the server stopped.
 *
 * **Nothing is resumed.** settles every interrupted run and re-runs nothing; a
 * cascade inherits that, and its result records which members completed, which
 * failed, and which never started.
 *
 * Ordering matters: this runs *after* the job sweep, so a member whose job was
 * settled there is already terminal and this only has to describe members that
 * never reached one.
 */
export function recoverInterruptedCascades(): number {
  const stranded = nonTerminalCascades();
  if (stranded.length === 0) return 0;

  const now = new Date().toISOString();
  let settled = 0;
  for (const cascade of stranded) {
    for (const member of cascade.members) {
      // Every member that had a job keeps its attempt with the run: a member
      // published as succeeded just before the stop may not have been
      // snapshotted yet.
      if (member.jobId && member.state !== "running") {
        const job = getJob(member.jobId);
        if (job) snapshotAttempt(cascade.id, member.stepId, job);
      }
      // A member that had a job: the job sweep above already said what became
      // of it, and the member follows. One that never started never will.
      if (member.state === "running") {
        setMember(cascade.id, member.stepId, {
          state: "failed",
          stoppedBy: "operation_interrupted",
        });
        // The sweep above settled its job; keep that attempt with the run.
        const job = member.jobId ? getJob(member.jobId) : null;
        if (job) snapshotAttempt(cascade.id, member.stepId, job);
      } else if (member.state === "pending") {
        setMember(cascade.id, member.stepId, {
          state: "not_run",
          stoppedBy: "operation_interrupted",
        });
      }
    }
    if (finishCascade(cascade.id, "interrupted", now)) settled += 1;
  }
  console.warn(
    `boot: settled ${settled} cascade(s) left active by a stopped process`,
  );
  return settled;
}
