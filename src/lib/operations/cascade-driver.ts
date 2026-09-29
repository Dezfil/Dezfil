import { AuthError } from "@/lib/auth/errors";
import { settleInactiveCascade } from "./cascade-inactive";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { finishCascade, getCascade, isCancelled, setMember, snapshotAttempt, type MemberState } from "@/lib/metadata/owned-cascades";
import { getJob, type OperationJob } from "@/lib/metadata/owned-jobs";
import { isTerminal } from "@/lib/metadata/jobs";
import { markAndSignalRunCancellation, pruneRunCancellation, waitForRunCancellation, type RunCancellation } from "./run";
import { startStepRun } from "./step-execution";
import * as lane from "./lane";

/** Which steps each member depends on, confined to the members themselves. */
export type Graph = Map<string, string[]>;

/** Cancel one newly admitted member without letting job-history pruning erase
 * the run's own attempt first. */
export async function cancelAdmittedMember(
  scope: AccountScope,
  cascadeId: string,
  stepId: string,
  jobId: string,
): Promise<void> {
  const cancellation = markAndSignalRunCancellation(scope, jobId);
  const stopped = getJob(scope, jobId) ?? cancellation.job;
  snapshotAttempt(scope, cascadeId, stepId, stopped);
  pruneRunCancellation(cancellation);
  await waitForRunCancellation(cancellation);
}

function blockedBy(
  graph: Graph,
  stepId: string,
  states: Map<string, string>,
): string | null {
  for (const dep of graph.get(stepId) ?? []) {
    const state = states.get(dep);
    if (state === undefined) continue; // not a member of this cascade
    if (state !== "succeeded") return dep;
  }
  return null;
}

/** Stop admitted engine work before any failure-recording metadata writes. */
async function drainAdmittedJobs(
  scope: AccountScope,
  admitted: Map<string, string>,
): Promise<Map<string, OperationJob>> {
  const jobs = new Map<string, OperationJob>();
  const cancellations: { stepId: string; cancellation: RunCancellation }[] = [];

  // Signal the whole admitted set before awaiting any one member. The local
  // ledger survives the metadata read that brought the coordinator here.
  for (const [stepId, jobId] of admitted) {
    const job = getJob(scope, jobId);
    if (!job) continue;
    if (isTerminal(job.state)) {
      jobs.set(stepId, job);
      continue;
    }
    const cancellation = markAndSignalRunCancellation(scope, jobId);
    jobs.set(stepId, cancellation.job);
    cancellations.push({ stepId, cancellation });
  }
  for (const { cancellation } of cancellations) pruneRunCancellation(cancellation);
  await Promise.all(
    cancellations.map(async ({ stepId, cancellation }) => {
      jobs.set(stepId, await waitForRunCancellation(cancellation));
    }),
  );
  return jobs;
}

/** Record one drained coordinator failure from fresh durable reads. */
function recordFailedCascade(
  scope: AccountScope,
  cascadeId: string,
  members: { stepId: string }[],
  admitted: Map<string, string>,
  drained: Map<string, OperationJob>,
): void {
  // Only after the engine is drained does the durable parent move. Successful
  // publications already wrote their member and output atomically; every other
  // admitted job is described from its terminal record.
  const current = getCascade(scope, cascadeId);
  if (!current) throw new Error(`Cascade ${cascadeId} disappeared during failure settlement.`);
  for (const member of members) {
    const jobId = admitted.get(member.stepId);
    const job = (jobId ? getJob(scope, jobId) : null) ?? drained.get(member.stepId);
    if (!job) {
      if (!admitted.has(member.stepId)) {
        setMember(scope, cascadeId, member.stepId, {
          state: "not_run",
          stoppedBy: "internal",
          stoppedReason: "The run stopped because its coordinator failed.",
        });
      }
      continue;
    }
    snapshotAttempt(scope, cascadeId, member.stepId, job);
    const recorded = current.members.find((candidate) => candidate.stepId === member.stepId);
    if (recorded?.state === "succeeded" && job.state === "succeeded") continue;
    setMember(scope, cascadeId, member.stepId, {
      state: "failed",
      jobId: job.id,
      stoppedBy: job.errorCode ?? job.state,
      ...(job.errorMessage ? { stoppedReason: job.errorMessage } : {}),
    });
  }
  finishCascade(scope, cascadeId, "failed", new Date().toISOString());
}

/** Drain once, then make one bounded fresh-read recording re-attempt. */
export async function settleCoordinatorFailure(
  scope: AccountScope,
  cascadeId: string,
  members: { stepId: string }[],
  admitted: Map<string, string>,
): Promise<void> {
  const drained = await drainAdmittedJobs(scope, admitted);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      recordFailedCascade(scope, cascadeId, members, admitted, drained);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn(
        `[operations] cascade ${cascadeId} failure settlement will retry from fresh reads:`,
        error,
      );
    }
  }
}

export async function driveCascade(
  scope: AccountScope,
  cascadeId: string,
  members: { stepId: string; ordinal: number }[],
  graph: Graph,
  /** A member admitted before the drive began (a node's own run): already
   * running, its job in flight, so the loop only waits for it. */
  preadmitted?: { stepId: string; jobId: string },
): Promise<void> {
  const states = new Map<string, MemberState>(
    members.map((m) => [m.stepId, m.stepId === preadmitted?.stepId ? "running" : "pending"]),
  );
  const inflight = new Map<string, Promise<string>>();
  const admitted = new Map<string, string>();
  if (preadmitted) {
    admitted.set(preadmitted.stepId, preadmitted.jobId);
    inflight.set(preadmitted.stepId, lane.jobSettled(preadmitted.jobId).then(() => preadmitted.stepId));
  }

  const settle = (
    stepId: string,
    state: MemberState,
    stoppedBy?: string,
    output?: { id: string; name: string },
    /** The server's own sentence, where there is one. `stoppedBy` is a code, a
     * blocking step id or "cancelled", and none of those can name *which*
     * table is gone — which is the only thing the user can act on. */
    stoppedReason?: string,
  ) => {
    states.set(stepId, state);
    setMember(scope, cascadeId, stepId, {
      state,
      ...(stoppedBy ? { stoppedBy } : {}),
      ...(output ? { output } : {}),
      ...(stoppedReason ? { stoppedReason } : {}),
    });
  };

  try {
    requireAccountScope(scope);
    for (;;) {
      // The fence, read from durable state before anything is admitted. This is
      // the check that must survive a cancel landing while the running members
      // are still being interrupted. It gates admission only: once it is up
      // nothing more is admitted, but the loop goes on waiting for every member
      // already in flight and records each as it settles below. Leaving here
      // instead stranded a second in-flight member as `running` inside a run
      // whose outcome was already `cancelled`, at any concurrency: one
      // executing and one queued in the lane are both recorded running.
      const ready = isCancelled(scope, cascadeId)
        ? []
        : members.filter(
            (m) =>
              states.get(m.stepId) === "pending" &&
              (graph.get(m.stepId) ?? []).every(
                (d) => !states.has(d) || states.get(d) === "succeeded",
              ),
          );

      for (const member of ready) {
        if (isCancelled(scope, cascadeId)) break;
        try {
          const job = await startStepRun(scope, member.stepId, { cascadeId });
          // Record acceptance before any later coordinator metadata read can
          // fail, so the catch can still find and drain this job.
          admitted.set(member.stepId, job.id);
          // Read the fence **again**, because admission is asynchronous: a
          // cancel arriving while this member was compiling and being admitted
          // saw it as still pending, found no job to interrupt, and left. The
          // job exists now, so this is the only place that can stop it — and
          // without this the cascade admits work after it was cancelled, which
          // is the one thing the fence exists to prevent.
          if (isCancelled(scope, cascadeId)) {
            // Admitted, then stopped: a failed member whose attempt was
            // cancelled, its job kept; not_run is for work never
            // admitted.
            await cancelAdmittedMember(scope, cascadeId, member.stepId, job.id);
            setMember(scope, cascadeId, member.stepId, { state: "failed", jobId: job.id, stoppedBy: "cancelled" });
            states.set(member.stepId, "failed");
            break;
          }
          states.set(member.stepId, "running");
          setMember(scope, cascadeId, member.stepId, { state: "running", jobId: job.id });
          inflight.set(
            member.stepId,
            lane.jobSettled(job.id).then(() => member.stepId),
          );
        } catch (error) {
          if (error instanceof AuthError) throw error;
          // Refused at admission — a taken name, a vanished input. No job was
          // minted, and this member's failure stops what depends on it.
          //
          // The sentence, kept — but only a coded refusal's (the boundary):
          // an unexpected failure's raw message can carry paths and
          // internals, and this row is durable and API-exposed, so it takes
          // the documented internal sentence and the detail goes to the log.
          if (!(error instanceof ApiError)) {
            console.error(
              `[operations] cascade member ${member.stepId} failed at admission:`,
              error,
            );
          }
          settle(
            member.stepId,
            "failed",
            error instanceof ApiError ? error.code : "internal",
            undefined,
            error instanceof ApiError
              ? error.message
              : "An unexpected server error occurred.",
          );
        }
      }

      if (inflight.size === 0) break;

      const finished = await Promise.race(inflight.values());
      inflight.delete(finished);
      const jobId = getCascade(scope, cascadeId)!.members.find(
        (m) => m.stepId === finished,
      )!.jobId;
      // The attempt stays with the run: copied now, while the job is
      // still there to copy, whatever became of it.
      const settledJob = jobId ? getJob(scope, jobId) : null;
      if (settledJob) snapshotAttempt(scope, cascadeId, finished, settledJob);
      // **The member row is the authority, not the job.** A successful
      // publication already wrote this member's success and its output inside
      // its own commit; a job lookup here can find nothing, because history is
      // capped per subject and a concurrent run of the same step can evict it
      // between settlement and this read. So the job is consulted only for a
      // member the publication did *not* claim — which is exactly the failed,
      // cancelled and interrupted cases, none of which wrote one.
      const published = getCascade(scope, cascadeId)!.members.find(
        (m) => m.stepId === finished,
      )!;
      if (published.state === "succeeded") {
        states.set(finished, "succeeded");
        continue;
      }
      const job = jobId ? getJob(scope, jobId) : null;
      // A member whose job was cancelled reads *failed* here, and its job still
      // says `cancelled` — the member vocabulary is completed, failed and
      // never-started, and inventing a sixth member state to mirror a job
      // state would put the two records in competition.
      settle(finished, "failed", job ? (job.errorCode ?? job.state) : undefined);
    }

    // Only now, with nothing left in flight: anything still waiting was never
    // attempted. A cancelled cascade says so; otherwise the member names what
    // stopped it, and mints no job either way.
    const cancelled = isCancelled(scope, cascadeId);
    for (const member of members) {
      if (states.get(member.stepId) !== "pending") continue;
      settle(
        member.stepId,
        "not_run",
        cancelled ? "cancelled" : (blockedBy(graph, member.stepId, states) ?? "cancelled"),
      );
    }

    const final = [...states.values()];
    const outcome = cancelled
      ? "cancelled"
      : final.every((s) => s === "succeeded")
        ? "completed"
        : final.some((s) => s === "succeeded")
          ? "partly_completed"
          : "failed";
    finishCascade(scope, cascadeId, outcome, new Date().toISOString());
  } catch (error) {
    // The drive is detached, so a stumble here must not become an unhandled
    // rejection. Admitted work is drained before failure recording; if the
    // bounded recording retry is exhausted, restart owns the active record.
    try {
      if (await settleInactiveCascade(cascadeId, admitted)) return;
      console.error(`[operations] cascade ${cascadeId} failed to drive:`, error);
      await settleCoordinatorFailure(scope, cascadeId, members, admitted);
    } catch (settlementError) {
      try { if (await settleInactiveCascade(cascadeId, admitted)) return; } catch { /* Restart reconciles unavailable metadata. */ }
      // The engine drain is attempted before any terminal parent write. A
      // metadata outage here leaves the active row for the retry/restart road,
      // never a false terminal parent or an outward rejection.
      console.error(
        `[operations] cascade ${cascadeId} failed to record its drained members:`,
        settlementError,
      );
    }
  }
}

