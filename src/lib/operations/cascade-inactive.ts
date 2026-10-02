import { metadataDb } from "@/lib/metadata/db";
import { finishCascade, getCascade, getCascadeJob, setMember, snapshotAttempt } from "@/lib/metadata/cascades";
import { failInactiveJob, type OperationJob } from "@/lib/metadata/jobs";
import * as lane from "./lane";

/** Terminal bookkeeping for a run whose initiator is inactive. This cannot
 * start work, publish data, read a private response or change an active
 * initiator's run, whoever owns the workflow. */
export async function settleInactiveCascade(id: string, admitted: Map<string, string>): Promise<boolean> {
  const db = metadataDb();
  if (!db.prepare(`SELECT c.id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id
    JOIN accounts a ON a.id = COALESCE(c.initiator_id, r.owner_id) WHERE c.id = ? AND a.status <> 'active' AND c.outcome IS NULL`).get(id)) return false;
  const before = getCascade(id, db)!;
  const jobs = new Map<string, OperationJob>();
  const waiting: Promise<void>[] = [];
  for (const member of before.members) {
    const jobId = admitted.get(member.stepId) ?? member.jobId;
    if (!jobId) continue;
    const job = getCascadeJob(id, jobId, db);
    if (!job) {
      if (member.jobId === jobId && member.attempt && !db.prepare("SELECT id FROM operation_jobs WHERE id = ?").get(jobId)) waiting.push(lane.jobSettled(jobId));
      continue;
    }
    if (job.subjectKind !== "step" || job.subjectId !== member.stepId) continue;
    // Fence every unfinished job before any drain waits. Already committed
    // results stay intact, including their files and durable member output.
    if (failInactiveJob(jobId, db)) lane.cancel(jobId);
    jobs.set(member.stepId, getCascadeJob(id, jobId, db) ?? job);
    waiting.push(lane.jobSettled(jobId));
  }
  await Promise.all(waiting);
  db.transaction(() => {
    const current = getCascade(id, db);
    if (!current || current.outcome !== null) return;
    for (const member of current.members) {
      const saved = jobs.get(member.stepId);
      const job = saved ? (getCascadeJob(id, saved.id, db) ?? saved) : null;
      if (job) snapshotAttempt(id, member.stepId, job, db);
      if (member.state !== "pending" && member.state !== "running") continue;
      setMember(id, member.stepId, {
        state: job || member.state === "running" ? "failed" : "not_run",
        ...(job ? { jobId: job.id } : {}),
        stoppedBy: current.cancelled ? "cancelled" : "authentication_required",
        stoppedReason: "Sign in to continue.",
      }, db);
    }
    const members = getCascade(id, db)!.members;
    const outcome = current.cancelled ? "cancelled"
      : members.every(member => member.state === "succeeded") ? "completed"
      : members.some(member => member.state === "succeeded") ? "partly_completed" : "failed";
    finishCascade(id, outcome, new Date().toISOString(), db);
  })();
  return true;
}
