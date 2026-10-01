import { getStep as getOwnedStep } from "@/lib/metadata/owned-recipes";
import type { AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { setMember, requireCascadeMember } from "@/lib/metadata/owned-cascades";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { replaceEdges } from "@/lib/metadata/lineage";
import {
  promoteProposal,
  recordOutput,
  stepOwnsOutput,
  type RecipeStep,
} from "@/lib/metadata/recipes";
import { getOwnedTableByName } from "@/lib/metadata/owned-tables";
import type { BoundInput } from "./materialize";

/**
 * Publishing a step's run.
 *
 * Everything a successful step run must record happens **inside the publication
 * transaction**, through the authority callback materialization already offers.
 * That is not tidiness: the alternative is a window in which an output exists
 * and its lineage does not, and a reader landing in that window would be told a
 * step is current when nothing yet says what it read.
 *
 * Four things land together, or none do:
 *
 *  1. the run still has authority — the step exists and has not been superseded;
 *  2. the dataset row, written or swapped in place;
 *  3. the step's ownership of that output;
 *  4. its lineage, replaced with what this run actually bound.
 *
 * **Ownership is read, never received.** subject is a grouping identity any
 * caller may send; using it to authorize a replacement would let a client
 * overwrite any table by naming it. The only question asked here is whether the
 * *stored* step row already owns exactly this id and name.
 */

/** What a step run needs to know before it starts. */
export interface StepPublication {
  step: RecipeStep;
  /** The parameters this run is executing — the proposal when there is one. */
  running: Record<string, unknown>;
  /** True when those parameters are a proposal awaiting promotion (G3). */
  isProposal: boolean;
  /** The table this run replaces, when the step already owns one. */
  replaceTable?: { id: string; name: string };
}

/**
 * Decide how a step's run will publish, before any work starts.
 *
 * Returns the replacement target only when the step's *stored* row owns a table
 * that still exists under the same id and name. A step whose output was deleted
 * owns nothing runnable: it registers afresh under the recorded name, and the
 * new dataset carries a **new id**, because a deleted table's id is gone and
 * pretending otherwise would be inventing identity.
 */
export function planPublication(scope: AccountScope, stepId: string): StepPublication {
  const step = getOwnedStep(scope, stepId);
  if (!step) {
    throw resourceAbsent();
  }

  const running = step.proposedParameters ?? step.parameters;
  const isProposal = step.proposedParameters !== null;

  if (step.outputTableId && step.outputTableName) {
    const live = getOwnedTableByName(scope, step.outputTableName);
    if (live && live.id === step.outputTableId) {
      return { step, running, isProposal, replaceTable: { id: live.id, name: live.name } };
    }
    // The name is taken by a *different* table: the step cannot restore its
    // own output without overwriting a stranger, and choosing between those is
    // the user's (which belongs). It reports the conflict.
    if (live) {
      throw new ApiError(
        "name_taken",
        `This step's output was "${step.outputTableName}", and a different ` +
          `table now has that name. Re-running would overwrite it, so nothing ` +
          `was written.`,
        409,
      );
    }
  }

  return { step, running, isProposal };
}

/**
 * The authority callback for a step's run.
 *
 * Returning false abandons the whole transaction, which is how a run that lost
 * its claim leaves no output behind.
 */
export function stepAuthorizer(
  scope: AccountScope,
  plan: StepPublication,
  jobFinished: (db: Database, output: { id: string; name: string }) => boolean,
  /** When this run is a cascade member, its success is recorded there too —
   * in this transaction, so no later correlation can lose it to pruning. */
  cascadeId?: string,
  /** The job this publication settles, recorded with the runner's output. */
  jobId?: string,
) {
  return (
    table: { id: string; name: string },
    db: Database,
    inputs: BoundInput[],
  ): boolean => {
    // Still the live attempt? A step deleted, or its recipe deleted, while the
    // run worked has no row here — and E10's fence says a lost attempt may
    // finish computing but may not publish.
    const current = getOwnedStep(scope, plan.step.id, db);
    if (!current) return false;
    if (cascadeId) requireCascadeMember(scope, cascadeId, plan.step.id, db);

    // Superseded: the definition this run was executing is no longer the one
    // the step would run now.
    //
    // Asked of what the step *means*, not of where the change was written.
    // A proposal added to a completed step, a proposal edited again, and an
    // edit to a step that has never produced anything — which lands on the
    // active definition rather than becoming a proposal — are one situation
    // told three ways, and a check that only compared proposals would let the
    // third publish an output its own step's definition no longer describes.
    const runningNow = current.proposedParameters ?? current.parameters;
    if (JSON.stringify(runningNow) !== JSON.stringify(plan.running)) return false;

    // A replacement must still own exactly what it set out to replace.
    if (
      plan.replaceTable &&
      !stepOwnsOutput(plan.step.id, plan.replaceTable, db)
    ) {
      return false;
    }

    // The job's own success commits here too, so a published output and a
    // succeeded run can never disagree.
    if (!jobFinished(db, { id: table.id, name: table.name })) return false;

    // The step's association and the runner's own row, written together.
    recordOutput(
      plan.step.id,
      { id: table.id, name: table.name },
      new Date().toISOString(),
      db,
      { accountId: scope.accountId, jobId: jobId ?? null, runId: cascadeId ?? null },
    );
    // Replace, never append: a re-run may read different tables, and an edge
    // left behind would keep propagating staleness from one it no longer reads.
    replaceEdges(
      scope,
      plan.step.id,
      table.id,
      inputs.map((i) => ({
        inputTableId: i.id,
        inputTableName: i.name,
        boundArtifact: i.artifact,
      })),
      db,
    );
    // A proposal becomes the step's meaning only now that a run of it worked.
    if (plan.isProposal) promoteProposal(plan.step.id, db);

    if (cascadeId) {
      setMember(
        scope,
        cascadeId,
        plan.step.id,
        { state: "succeeded", output: { id: table.id, name: table.name } },
        db,
      );
    }

    return true;
  };
}
