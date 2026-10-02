import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { canReach, requirePermitted, requireReachable } from "@/lib/auth/reach";
import { metadataDb } from "./db";
import * as cascades from "./cascades";
export type { CascadeKind, CascadeRun, MemberIdentity, MemberState } from "./cascades";

/** The account that started a run: recorded on the run, the workflow's owner
 * for a record made before runs had initiators. */
const INITIATOR = "COALESCE(c.initiator_id, r.owner_id)";

/** A run as its driver reads it: its initiator, or its workflow's owner. */
export function getCascade(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const me = requireAccountScope(scope, db);
  if (!db.prepare(`SELECT c.id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id
    WHERE c.id = @id AND (${INITIATOR} = @me OR r.owner_id = @me)`).get({ id, me })) return null;
  return cascades.getCascade(id, db);
}
/**
 * A run's own driving: admitting its members, recording what became of them
 * and settling it. Its initiator's, read from the run itself, whether or not
 * they still reach its workflow; anyone else is absent.
 */
function requireRunInitiator(scope: AccountScope, id: string, db: Database) {
  const me = requireAccountScope(scope, db);
  if (!db.prepare(`SELECT c.id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id
    WHERE c.id = ? AND ${INITIATOR} = ?`).get(id, me)) throw resourceAbsent();
}
/** A run read, as its workflow is reached: everyone who reaches the workflow
 * reads its contained runs. */
export function readReachedCascade(scope: AccountScope, id: string, db: Database = metadataDb()) {
  if (!canReach(scope, "cascade", id, db)) return null;
  return cascades.getCascade(id, db);
}
/** A reached workflow's runs, newest first. */
export function listReachedCascades(scope: AccountScope, recipeId: string, db: Database = metadataDb()) {
  requireReachable(scope, "workflow", recipeId, db);
  return cascades.listCascades(recipeId, db);
}
/** Authority over a run's own record while it is stopped: its initiator's,
 * read from the run itself, or its workflow owner's. Anyone else is absent. */
function requireRunAuthority(scope: AccountScope, id: string, db: Database) {
  const me = requireAccountScope(scope, db);
  if (!db.prepare(`SELECT c.id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id
    WHERE c.id = @id AND (${INITIATOR} = @me OR r.owner_id = @me)`).get({ id, me })) throw resourceAbsent();
}

export function requireCascadeMember(scope: AccountScope, id: string, stepId: string, db: Database = metadataDb()) {
  requireRunInitiator(scope, id, db);
  if (!db.prepare("SELECT step_id FROM cascade_members WHERE cascade_id = ? AND step_id = ?").get(id, stepId)) throw resourceAbsent();
}
/** Record a run started by the acting account, who may run the workflow:
 * its owner, the project's owner acting as an editor, or an editor. */
export function createCascade(scope: AccountScope, recipeId: string, kind: cascades.CascadeKind, members: cascades.MemberIdentity[], db: Database = metadataDb()) {
  return db.transaction(() => {
    requirePermitted(scope, "workflow", recipeId, "run", db);
    for (const member of members) {
      if (!db.prepare("SELECT id FROM recipe_steps WHERE id = ? AND recipe_id = ?").get(member.stepId, recipeId)) throw resourceAbsent();
    }
    return cascades.createCascade(recipeId, kind, members, db, requireAccountScope(scope, db));
  })();
}
export function listCascades(scope: AccountScope, recipeId?: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  if (recipeId) requireOwnedResource(scope, "workflow", recipeId, db);
  const ids = db.prepare(`SELECT c.id FROM cascade_runs c JOIN recipes r ON r.id = c.recipe_id
    WHERE r.owner_id = ? ${recipeId ? "AND c.recipe_id = ?" : ""} ORDER BY c.started_at DESC, c.id DESC LIMIT 100`)
    .all(owner, ...(recipeId ? [recipeId] : [])) as { id: string }[];
  return ids.map(row => cascades.getCascade(row.id, db)!);
}
/** The workflow's run in flight, whoever started it: one at a time. */
export function activeCascade(scope: AccountScope, recipeId: string, db: Database = metadataDb()) {
  requireReachable(scope, "workflow", recipeId, db); return cascades.activeCascade(recipeId, db);
}
export function setMember(scope: AccountScope, id: string, stepId: string, update: Parameters<typeof cascades.setMember>[2], db: Database = metadataDb()) {
  db.transaction(() => {
    requireCascadeMember(scope, id, stepId, db);
    if (update.jobId) {
      const owner = requireAccountScope(scope, db);
      const live = db.prepare("SELECT id FROM operation_jobs WHERE id = ? AND owner_id = ? AND subject_kind = 'step' AND subject_id = ?").get(update.jobId, owner, stepId);
      const retained = db.prepare("SELECT step_id FROM cascade_members WHERE cascade_id = ? AND step_id = ? AND job_id = ? AND attempt_state IS NOT NULL").get(id, stepId, update.jobId);
      if (!live && !retained) throw resourceAbsent();
    }
    if (update.output) {
      const row = db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(update.output.id) as { owner_id: string } | undefined;
      if (row && row.owner_id !== scope.accountId) throw resourceAbsent();
    }
    cascades.setMember(id, stepId, update, db);
  })();
}
export function snapshotAttempt(scope: AccountScope, id: string, stepId: string, job: Parameters<typeof cascades.snapshotAttempt>[2], db: Database = metadataDb()) {
  requireRunAuthority(scope, id, db);
  if (!db.prepare("SELECT step_id FROM cascade_members WHERE cascade_id = ? AND step_id = ?").get(id, stepId)) throw resourceAbsent();
  const row = db.prepare("SELECT owner_id FROM operation_jobs WHERE id = ?").get(job.id) as { owner_id: string } | undefined;
  if ((row && row.owner_id !== scope.accountId) || job.subjectKind !== "step" || job.subjectId !== stepId) throw resourceAbsent();
  cascades.snapshotAttempt(id, stepId, job, db);
}
export function raiseCancelFence(scope: AccountScope, id: string, db: Database = metadataDb()) {
  requireRunAuthority(scope, id, db); return cascades.raiseCancelFence(id, db);
}
export function isCancelled(scope: AccountScope, id: string, db: Database = metadataDb()) {
  requireRunInitiator(scope, id, db); return cascades.isCancelled(id, db);
}
export function finishCascade(scope: AccountScope, id: string, outcome: cascades.CascadeOutcome, finishedAt: string, db: Database = metadataDb()) {
  requireRunInitiator(scope, id, db); return cascades.finishCascade(id, outcome, finishedAt, db);
}
export function deleteCascade(scope: AccountScope, id: string, db: Database = metadataDb()) {
  requireRunInitiator(scope, id, db); return cascades.deleteCascade(id, db);
}
