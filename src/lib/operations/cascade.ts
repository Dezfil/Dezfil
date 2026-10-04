import type { AccountActor } from "@/lib/account-actor";
import { accountActors } from "@/lib/metadata/account-actors";
import { readDocumentRevision, requireDocumentRevision } from "@/lib/metadata/revisions";
import type { DatasetScope } from "@/lib/query/access";
import { settleInactiveCascade } from "./cascade-inactive";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { driveCascade, cancelAdmittedMember, settleCoordinatorFailure, type Graph } from "./cascade-driver";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import {
  createCascade,
  finishCascade,
  getCascade,
  isCancelled,
  raiseCancelFence,
  setMember,
  type CascadeKind,
  type CascadeRun,
  activeCascade,
  deleteCascade,
  type MemberIdentity,
  readReachedCascade,
} from "@/lib/metadata/owned-cascades";
import * as cascades from "@/lib/metadata/cascades";
import { requireCancellable, requirePermitted } from "@/lib/auth/reach";
import { outputLinks } from "./output-links";
import { metadataDb } from "@/lib/metadata/db";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { isTerminal } from "@/lib/metadata/jobs";
// Planning and starting a run are for whoever may run the workflow; its
// definition is read as they reach it.
import { getRecipe, listSteps, type RecipeStep } from "@/lib/metadata/owned-recipes";
import { dependenciesWithin } from "./recipe-order";
import {
  markAndSignalMemberCancellation,
  pruneRunCancellation,
  waitForRunCancellation,
  type RunCancellation,
} from "./run";
import { startStepRun } from "./step-execution";
import { readsByStep } from "./step-reads";

/**
 * Running a recipe, or a step and everything that reads it.
 *
 * **Order is enforced by dependency, never by queue position.** A member is
 * submitted only once every member it reads has *succeeded*. Submitting the
 * whole set and trusting the lane's first-in-first-out arrival order would work
 * at the default concurrency of one and interleave the moment an administrator
 * raised it — which is why the ordering criteria run with it raised.
 *
 * **A step whose dependency failed is not attempted, and mints no job.** It is
 * reported `not_run` in the cascade's own result, naming what stopped it.
 * Members that do not depend on the failure still run: a cascade is a graph,
 * not a queue, and one broken branch is not the end of the others.
 *
 * **Cancellation is read from the fence, not from a variable.** The check
 * happens before every submission and the fence is a durable column, so a
 * cascade cancelled while it is interrupting its running members cannot admit
 * the next one in the gap. The fence gates admission only: the driver keeps
 * waiting for every member it already admitted and records each as it settles,
 * so a terminal run never holds a running member.
 *
 * **The blast radius stays inside this recipe** (G4). A dependent in another
 * recipe is marked by the ordinary staleness derivation and never run — a
 * workspace-wide cascade would reach into recipes the caller never opened.
 */

/** Drives in flight, so a caller — or a test — can await one. */
const drivingKey = Symbol.for("dezfil.cascade-drivers");
const drivingHost = globalThis as typeof globalThis & { [drivingKey]?: Map<string, Promise<void>> };
const driving = drivingHost[drivingKey] ??= new Map<string, Promise<void>>();

export function cascadeSettled(id: string): Promise<void> {
  return driving.get(id) ?? Promise.resolve();
}

async function dependencyGraph(scope: DatasetScope, steps: RecipeStep[]): Promise<Graph> {
  const reads = await readsByStep(scope, steps);
  const graph: Graph = new Map();
  for (const step of steps) {
    graph.set(
      step.id,
      dependenciesWithin(steps, reads.get(step.id) ?? []).map((d) => d.id),
    );
  }
  return graph;
}

/**
 * The members of a cascade started at one step: it, and everything that reads
 * it however far down — reached transitively, and each reached once.
 *
 * A dependent reachable by two paths is one member, so it runs once. That is
 * the diamond the spec insists a recipe's shape allows.
 */
function dependentsOf(graph: Graph, fromStepId: string): Set<string> {
  const chosen = new Set([fromStepId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [stepId, deps] of graph) {
      if (chosen.has(stepId)) continue;
      if (deps.some((d) => chosen.has(d))) {
        chosen.add(stepId);
        grew = true;
      }
    }
  }
  return chosen;
}

export interface CascadeRequest {
  recipeId: string;
  expectedRevision?: unknown;
  /** Absent runs the whole recipe from the beginning. */
  fromStepId?: string;
  /** The members a confirmation named, in order: the run starts
   * only when the plan at start is exactly that set in that order. */
  members?: string[];
}

/**
 * What a cascade *would* carry, without starting anything.
 *
 * The confirmation property is about blast radius: *run all* and a re-run with
 * dependents are wide, and the same control on a leaf is not. A caller has to
 * be able to ask which it is before it commits to one.
 */
export interface CascadePlan {
  editRevision: string;
  kind: CascadeKind;
  members: MemberIdentity[];
  graph: Graph;
  /** True when this would carry other steps with it — the property the
   * published description declares as needing confirmation. */
  wide: boolean;
}

/** A member's identity as the plan records it: what the node
 * is and what it is called, so the run names it after the node is gone. */
function identityOf(step: RecipeStep): MemberIdentity {
  const declared = step.parameters.name;
  return {
    stepId: step.id,
    ordinal: step.ordinal,
    operation: step.operation,
    name: step.outputTableName ?? (typeof declared === "string" && declared !== "" ? declared : null),
  };
}

/** Resolve every referenced child before comparing the parent revision. */
function authorizedSteps(scope: AccountScope, request: CascadeRequest): RecipeStep[] {
  requirePermitted(scope, "workflow", request.recipeId, "run");
  const steps = listSteps(scope, request.recipeId);
  for (const id of [...(request.fromStepId ? [request.fromStepId] : []), ...(request.members ?? [])]) {
    if (!steps.some(step => step.id === id)) throw resourceAbsent();
  }
  return steps;
}

export async function planCascade(scope: AccountScope, request: CascadeRequest): Promise<CascadePlan> {
  // Whoever may run the workflow plans it: anyone else is refused before
  // anything is read.
  const { steps, editRevision } = metadataDb().transaction(() => {
    const steps = authorizedSteps(scope, request);
    return { steps, editRevision: readDocumentRevision({ kind: "workflow", id: request.recipeId })!.editRevision! };
  })();
  if (steps.length === 0) {
    throw new ApiError("invalid_request", "This recipe has no steps to run.", 400);
  }
  const graph = await dependencyGraph(scope, steps);
  requirePermitted(scope, "workflow", request.recipeId, "run");

  if (!request.fromStepId) {
    return {
      editRevision,
      kind: "run_all",
      members: steps.map(identityOf),
      graph,
      wide: true,
    };
  }

  const from = steps.find((s) => s.id === request.fromStepId);
  if (!from) {
    throw new ApiError(
      "not_found",
      "The requested resource was not found.",
      404,
    );
  }
  const chosen = dependentsOf(graph, from.id);
  return {
    editRevision,
    kind: "from_step",
    members: steps.filter((s) => chosen.has(s.id)).map(identityOf),
    graph,
    // The same control on a leaf — a step nothing reads — carries only itself.
    wide: chosen.size > 1,
  };
}

/**
 * One run at a time per workflow: the check for a run in flight and the
 * record of the new one are one transaction, so two starts that race yield
 * one run and one refusal naming it.
 */
export interface StartedRun extends CascadeRun { editRevision: string }

export function recordUnderLock(scope: AccountScope, recipeId: string, kind: CascadeKind, members: MemberIdentity[], expectedRevision: unknown): StartedRun {
  const db = metadataDb();
  return db.transaction(() => {
    authorizedSteps(scope, { recipeId, members: members.map(member => member.stepId) });
    requireDocumentRevision(scope, { kind: "workflow", id: recipeId, action: "run", expectedRevision }, db);
    const active = activeCascade(scope, recipeId, db);
    if (active) {
      throw new ApiError(
        "run_in_flight",
        `${publishedMessage("run_in_flight")} The run in flight is ${active.id}.`,
        409,
      );
    }
    return { ...createCascade(scope, recipeId, kind, members, db), editRevision: readDocumentRevision({ kind: "workflow", id: recipeId }, db)!.editRevision! };
  })();
}

export async function startCascade(scope: AccountScope, request: CascadeRequest): Promise<StartedRun> {
  // The caller's read is the sole start basis. Planning may await the parser,
  // but a changed document refuses rather than recomposing that intent.
  metadataDb().transaction(() => {
    authorizedSteps(scope, request);
    requireDocumentRevision(scope, { kind: "workflow", id: request.recipeId, action: "run", expectedRevision: request.expectedRevision });
  })();
  const plan = await planCascade(scope, request);
  const cascade = metadataDb().transaction(() => {
    authorizedSteps(scope, request);
    requireDocumentRevision(scope, { kind: "workflow", id: request.recipeId, action: "run", expectedRevision: request.expectedRevision });
    const planned = plan.members.map(member => member.stepId);
    if (request.members && (planned.length !== request.members.length || planned.some((id, i) => id !== request.members![i]))) {
      throw new ApiError("plan_changed", publishedMessage("plan_changed"), 409);
    }
    return recordUnderLock(scope, request.recipeId, plan.kind, plan.members, request.expectedRevision);
  }).immediate();
  const { members, graph } = plan;

  const drive = driveCascade(scope, cascade.id, members, graph).finally(() => {
    driving.delete(cascade.id);
  });
  driving.set(cascade.id, drive);
  // Deliberately not awaited: a cascade outlives the request that started it,
  // exactly as a run does. An unhandled rejection here would kill the process,
  // so the drive itself never throws.
  void drive;
  return { ...getCascade(scope, cascade.id)!, editRevision: cascade.editRevision };
}

/** What blocks a member: the nearest member it depends on that did not succeed. */
/**
 * A node's own run: one of the workflow's runs, with one member, under the
 * same lock and driven by the same driver — the job is the attempt. Its
 * lifecycle is registered before admission so a cancellation of the
 * listable pending row waits for the same settlement. Ordinary admission
 * refusal still removes that row and leaves no attempt; accepted
 * cancellation retains the row and its refusal member.
 */
export async function startSingleRun(scope: AccountScope, recipeId: string, stepId: string, options: { expectedRevision?: unknown } = {}): Promise<StartedRun> {
  requireAccountScope(scope);
  requirePermitted(scope, "workflow", recipeId, "run");
  const recipe = getRecipe(scope, recipeId);
  if (!recipe) {
    throw resourceAbsent();
  }
  const step = listSteps(scope, recipeId).find((s) => s.id === stepId);
  if (!step) {
    throw resourceAbsent();
  }
  const identity = identityOf(step);
  const cascade = recordUnderLock(scope, recipeId, "single", [identity], options.expectedRevision);
  let resolveStarted!: (run: StartedRun) => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<StartedRun>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  // Start on the next microtask so the lifecycle is registered before
  // admission begins. A cancel that finds the durable pending member can then
  // wait for the same work that will either admit it or record its refusal.
  const admitted = new Map<string, string>();
  const lifecycle = Promise.resolve()
    .then(async () => {
      let job;
      try {
        job = await startStepRun(scope, stepId, { cascadeId: cascade.id });
        admitted.set(stepId, job.id);
      } catch (error) {
        if (isCancelled(scope, cascade.id)) {
          if (!(error instanceof ApiError)) {
            console.error(
              `[operations] single cascade member ${stepId} failed at admission:`,
              error,
            );
          }
          setMember(scope, cascade.id, stepId, {
            state: "failed",
            stoppedBy: error instanceof ApiError ? error.code : "internal",
            stoppedReason:
              error instanceof ApiError
                ? error.message
                : "An unexpected server error occurred.",
          });
          finishCascade(scope, cascade.id, "cancelled", new Date().toISOString());
        } else {
          deleteCascade(scope, cascade.id);
        }
        rejectStarted(error);
        return;
      }

      // A cancel accepted during admission owns the durable result. The job
      // exists now, so stop it here and finish the retained parent before the
      // cancel waiter answers.
      if (isCancelled(scope, cascade.id)) {
        await cancelAdmittedMember(scope, cascade.id, stepId, job.id);
        setMember(scope, cascade.id, stepId, {
          state: "failed",
          jobId: job.id,
          stoppedBy: "cancelled",
        });
        finishCascade(scope, cascade.id, "cancelled", new Date().toISOString());
        resolveStarted({ ...getCascade(scope, cascade.id)!, editRevision: cascade.editRevision });
        return;
      }

      setMember(scope, cascade.id, stepId, { state: "running", jobId: job.id });
      resolveStarted({ ...getCascade(scope, cascade.id)!, editRevision: cascade.editRevision });
      const graph: Graph = new Map([[stepId, []]]);
      await driveCascade(scope, cascade.id, [identity], graph, { stepId, jobId: job.id });
    })
    .catch(async error => {
      try {
        if (!await settleInactiveCascade(cascade.id, admitted)) await settleCoordinatorFailure(scope, cascade.id, [identity], admitted);
      } catch (settlementError) {
        console.error(`[operations] single cascade ${cascade.id} could not record settlement:`, settlementError);
      } finally { rejectStarted(error); }
    })
    .finally(() => {
      driving.delete(cascade.id);
    });
  driving.set(cascade.id, lifecycle);
  void lifecycle;
  return started;
}

export interface CascadeView extends CascadeRun {
  /** Every dataset this cascade produced, from its members' own jobs. */
  outputs: { id: string; name: string }[];
  /** Whose run it is: its outputs and lineage are that person's. Null for a
   * run recorded before runs were attributed. */
  runner: AccountActor | null;
}

/**
 * A cascade as a caller reads it.
 *
 * The outputs come from the member rows. Deriving them from the members' jobs
 * reads better — one fact, one home — and is wrong: job history is capped per
 * subject, so an older cascade would report no outputs at all once its steps
 * had been re-run enough times, while its own row sat there claiming to be a
 * durable result.
 */
export function readCascade(scope: AccountScope, id: string): CascadeView {
  const stored = readReachedCascade(scope, id);
  if (!stored) {
    throw resourceAbsent();
  }
  // A run follows its workflow: everyone who reaches the workflow reads it,
  // with every output link the reader cannot follow left out.
  const linked = outputLinks(scope, stored);
  const cascade = {
    ...stored,
    members: stored.members.map((m) => ({
      ...m,
      output: linked(m.output),
      attempt: m.attempt ? { ...m.attempt, output: linked(m.attempt.output) } : null,
    })),
  };
  // From the member rows, not from the jobs. A job is pruned once its
  // subject's history is deep enough, and a durable result that forgot what it
  // produced would be a worse record than none.
  const outputs = cascade.members
    .filter((m) => m.state === "succeeded" && m.output !== null)
    .map((m) => m.output!);
  const row = metadataDb().prepare("SELECT initiator_id FROM cascade_runs WHERE id = ?").get(id) as { initiator_id: string | null };
  const runner = row.initiator_id ? accountActors([row.initiator_id]).get(row.initiator_id) ?? null : null;
  return { ...cascade, outputs, runner };
}

/**
 * Stop a cascade.
 *
 * The fence goes up **first**, so nothing further is admitted while the running
 * members are interrupted; then each running member's job is cancelled, which
 * stops the statement itself rather than merely its bookkeeping. Finished
 * members stay finished and their outputs stand. The wait at the end is for
 * the driver, which records every interrupted member as it settles and only
 * then writes the outcome, so what this returns is the whole record.
 *
 * The members' jobs are the run's initiator's, whoever cancels: the workflow's
 * owner stopping a run someone else started interrupts that person's jobs,
 * read and stopped through the run itself.
 */
export async function cancelCascade(scope: AccountScope, id: string): Promise<CascadeRun> {
  // The run's initiator or its workflow's owner.
  requireCancellable(scope, id);
  const beforeFence = cascades.getCascade(id);
  if (!beforeFence) {
    throw resourceAbsent();
  }
  // Terminal is not an error: cancel means *make sure this is not running*, and
  // for one that already finished that is true (G5's reasoning, one level up).
  if (beforeFence.outcome !== null) return beforeFence;

  raiseCancelFence(scope, id);
  // The actionable snapshot is after the fence: every member it names was
  // admitted before cancellation won, and no later admission can join it.
  const cascade = cascades.getCascade(id) ?? beforeFence;
  const cancellations: { stepId: string; cancellation: RunCancellation }[] = [];
  for (const member of cascade.members) {
    if (member.state !== "running" || !member.jobId) continue;
    const job = cascades.getCascadeJob(id, member.jobId);
    if (job && job.subjectKind === "step" && job.subjectId === member.stepId && !isTerminal(job.state)) {
      cancellations.push({
        stepId: member.stepId,
        cancellation: markAndSignalMemberCancellation(id, member.jobId),
      });
    }
  }
  // Every mark and signal above lands before the first prune or wait. In a
  // one-slot lane the queued member is therefore removed before the executing
  // member can release its slot.
  // The run owns its attempt before job history applies its independent cap.
  // This explicit boundary is what keeps the attempt at depth one; relying on
  // the driver's later settlement loses the job when pruning wins the race.
  for (const { stepId, cancellation } of cancellations) {
    const stopped = cascades.getCascadeJob(id, cancellation.job.id) ?? cancellation.job;
    cascades.snapshotAttempt(id, stepId, stopped);
  }
  for (const { cancellation } of cancellations) pruneRunCancellation(cancellation);
  await Promise.all(
    cancellations.map(({ cancellation }) => waitForRunCancellation(cancellation)),
  );
  await cascadeSettled(id);
  // The answer is the canceller's: withheld from one deactivated meanwhile.
  requireAccountScope(scope);
  return cascades.getCascade(id) ?? cascade;
}

export function cascadeDriversForTests(): string[] { return [...driving.keys()]; }
