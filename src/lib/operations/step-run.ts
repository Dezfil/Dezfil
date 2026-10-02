import { recordStepEdit } from "@/lib/metadata/workflow-recording";
import { getStep as getReachedStep } from "@/lib/metadata/owned-recipes";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { setMember, requireCascadeMember } from "@/lib/metadata/owned-cascades";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { isPermitted } from "@/lib/auth/reach";
import { replaceEdges } from "@/lib/metadata/lineage";
import {
  getStep as getStepRow,
  promoteProposal,
  recordOutput,
  type RecipeStep,
} from "@/lib/metadata/recipes";
import { runnerOutput, runnerOwnsOutput } from "@/lib/metadata/recipe-outputs";
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
 * *stored* record of this runner's output of the step already names exactly
 * this id and name.
 *
 * **A run is its runner's.** Whoever may run the workflow runs it as
 * themselves: the output is the runner's own dataset, and the record kept is
 * the runner's own row for the step, so one runner never replaces another's
 * output. A rerun replaces only the same runner's recorded output of the same
 * step.
 *
 * **Authority is asked again at commit.** A runner who may no longer run the
 * workflow when the output commits (no longer its editor, or no longer
 * reaching it) still completes what was admitted, privately: the dataset is
 * written into the runner's own space and the job and the run record what
 * happened, but the workflow's record is not touched. No output row, no
 * lineage, no promotion of a proposal, and no filing (the filer asks the same
 * question). The runner must still be active, and every input still within
 * their reach, which the publication checks before this.
 */

/** What a step run needs to know before it starts. */
export interface StepPublication {
  step: RecipeStep;
  /** The parameters this run is executing — the proposal when there is one. */
  running: Record<string, unknown>;
  /** True when those parameters are a proposal awaiting promotion (G3). */
  isProposal: boolean;
  /** The table this run replaces, when this runner's earlier run of the step
   * recorded one. */
  replaceTable?: { id: string; name: string };
}

/**
 * Decide how a step's run will publish, before any work starts.
 *
 * Returns the replacement target only when this runner's recorded output of
 * the step still exists under the same id and name, in the runner's own
 * space. An output that was deleted leaves nothing runnable to replace: the
 * run registers afresh under the recorded name, and the new dataset carries a
 * **new id**, because a deleted table's id is gone and pretending otherwise
 * would be inventing identity. Another runner's output is never a target.
 */
export function planPublication(scope: AccountScope, stepId: string): StepPublication {
  const runner = requireAccountScope(scope);
  const step = getReachedStep(scope, stepId);
  if (!step) {
    throw resourceAbsent();
  }

  const running = step.proposedParameters ?? step.parameters;
  const isProposal = step.proposedParameters !== null;

  const recorded = runnerOutput(step.id, runner);
  if (recorded) {
    const live = getOwnedTableByName(scope, recorded.name);
    if (live && live.id === recorded.id) {
      return { step, running, isProposal, replaceTable: { id: live.id, name: live.name } };
    }
    // The name is taken by a *different* table: the step cannot restore its
    // own output without overwriting a stranger, and choosing between those is
    // the user's (which belongs). It reports the conflict.
    if (live) {
      throw new ApiError(
        "name_taken",
        `This step's output was "${recorded.name}", and a different ` +
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
    const current = getStepRow(plan.step.id, db);
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

    // A replacement must still be exactly this runner's recorded output.
    if (
      plan.replaceTable &&
      !runnerOwnsOutput(plan.step.id, scope.accountId, plan.replaceTable, db)
    ) {
      return false;
    }

    // The job's own success commits here too, so a published output and a
    // succeeded run can never disagree.
    if (!jobFinished(db, { id: table.id, name: table.name })) return false;

    // Whether the output joins the workflow's record is decided by the
    // runner's standing now, not when the run was admitted.
    if (isPermitted(scope, "step", plan.step.id, "run", db)) {
      // The runner's own row and the step's latest association, written together.
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
      if (plan.isProposal) recordStepEdit(scope, plan.step.id, () => promoteProposal(plan.step.id, db), db);
    }

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
