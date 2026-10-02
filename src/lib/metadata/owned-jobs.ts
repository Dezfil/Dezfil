import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requirePermitted, requireReachable } from "@/lib/auth/reach";
import { metadataDb } from "./db";
import * as jobs from "./jobs";
export type { OperationJob, JobQuery, JobOutcome } from "./jobs";

export function getJob(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const row = db.prepare("SELECT * FROM operation_jobs WHERE id = ? AND owner_id = ?").get(id, owner) as jobs.JobRow | undefined;
  return row ? jobs.jobFromRow(row) : null;
}
export function requireJob(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const job = getJob(scope, id, db);
  if (!job) throw resourceAbsent();
  return job;
}
export function listJobs(scope: AccountScope, query: jobs.JobQuery = {}, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const where = ["owner_id = ?"], args = [owner];
  if (query.subjectId) { where.push("subject_id = ?"); args.push(query.subjectId); }
  if (query.subjectKind) { where.push("subject_kind = ?"); args.push(query.subjectKind); }
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
  return (db.prepare(`SELECT * FROM operation_jobs WHERE ${where.join(" AND ")}
    ORDER BY accepted_at DESC, id DESC LIMIT ${limit}`).all(...args) as jobs.JobRow[]).map(jobs.jobFromRow);
}
/** A step's most recent attempt, whoever made it: a step's attempts are
 * contained in its workflow and read by everyone who reaches it. */
export function latestStepAttempt(scope: AccountScope, stepId: string, db: Database = metadataDb()) {
  requireReachable(scope, "step", stepId, db);
  const row = db.prepare(`SELECT * FROM operation_jobs WHERE subject_kind = 'step' AND subject_id = ?
    ORDER BY accepted_at DESC, id DESC LIMIT 1`).get(stepId) as jobs.JobRow | undefined;
  return row ? jobs.jobFromRow(row) : null;
}
/** Mint a job for the acting account. A step's job is admitted only for an
 * account that may run the step's workflow now; the job is that runner's. */
export function insertJob(scope: AccountScope, job: jobs.OperationJob, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireAccountScope(scope, db);
    if (job.subjectKind === "step") requirePermitted(scope, "step", job.subjectId, "run", db);
    jobs.insertJob(scope, job, db);
  })();
}
function mutate(scope: AccountScope, id: string, db: Database, action: () => boolean) {
  return db.transaction(() => {
    const owner = requireAccountScope(scope, db);
    if (!db.prepare("SELECT id FROM operation_jobs WHERE id = ? AND owner_id = ?").get(id, owner)) return false;
    return action();
  })();
}
export function deleteJob(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return mutate(scope, id, db, () => jobs.deleteJob(id, db));
}
export function markRunning(scope: AccountScope, id: string, startedAt: string, db: Database = metadataDb()) {
  return mutate(scope, id, db, () => jobs.markRunning(id, startedAt, db));
}
export function finish(scope: AccountScope, id: string, outcome: jobs.JobOutcome, finishedAt: string, db: Database = metadataDb()) {
  return mutate(scope, id, db, () => jobs.finish(id, outcome, finishedAt, db));
}
