import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { driveCascade, cancelAdmittedMember, type Graph } from "./cascade-driver";
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
  snapshotAttempt,
  type MemberIdentity,
} from "@/lib/metadata/cascades";
import { metadataDb } from "@/lib/metadata/db";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { getJob, isTerminal } from "@/lib/metadata/jobs";
import { getRecipe, listSteps, type RecipeStep } from "@/lib/metadata/recipes";
import { dependenciesWithin } from "./recipe-order";
import {
  markAndSignalRunCancellation,
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
const driving = new Map<string, Promise<void>>();

export function cascadeSettled(id: string): Promise<void> {
  return driving.get(id) ?? Promise.resolve();
}

async function dependencyGraph(steps: RecipeStep[]): Promise<Graph> {
  const reads = await readsByStep(steps);
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

export async function planCascade(request: CascadeRequest): Promise<CascadePlan> {
  const recipe = getRecipe(request.recipeId);
  if (!recipe) {
    throw new ApiError("not_found", `No recipe with id "${request.recipeId}".`, 404);
  }
  const steps = listSteps(request.recipeId);
  if (steps.length === 0) {
    throw new ApiError("invalid_request", `This recipe has no steps to run.`, 400);
  }
  const graph = await dependencyGraph(steps);

  if (!request.fromStepId) {
    return {
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
      `No step with id "${request.fromStepId}" in this recipe.`,
      404,
    );
  }
  const chosen = dependentsOf(graph, from.id);
  return {
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
export function recordUnderLock(recipeId: string, kind: CascadeKind, members: MemberIdentity[]): CascadeRun {
  const db = metadataDb();
  return db.transaction(() => {
    const active = activeCascade(recipeId, db);
    if (active) {
      throw new ApiError(
        "run_in_flight",
        `${publishedMessage("run_in_flight")} The run in flight is ${active.id}.`,
        409,
      );
    }
    return createCascade(recipeId, kind, members, db);
  })();
}

/** The workflow's last-edited mark: what a plan was made from. */
function basisOf(recipeId: string): string | null {
  return getRecipe(recipeId)?.updatedAt ?? null;
}

export async function startCascade(scope: AccountScope, request: CascadeRequest): Promise<CascadeRun> {
  requireAccountScope(scope);
  // Planning waits on the parser, so the workflow may change while the
  // server plans; the record is made only from a plan of the workflow as
  // it stands, re-planned when the mark moved (a bounded number of times).
  let plan: CascadePlan | null = null;
  let cascade: CascadeRun | null = null;
  for (let attempt = 0; attempt < 3 && cascade === null; attempt += 1) {
    const basis = basisOf(request.recipeId);
    plan = await planCascade(request);
    const planned = plan.members.map((m) => m.stepId);
    // The confirmation binds the membership and the order, nothing else: a
    // plan that differs at start refuses whole.
    if (request.members) {
      const same = planned.length === request.members.length && planned.every((id, i) => id === request.members![i]);
      if (!same) throw new ApiError("plan_changed", publishedMessage("plan_changed"), 409);
    }
    const members = plan.members;
    const db = metadataDb();
    cascade = db.transaction((): CascadeRun | null => {
      if (basisOf(request.recipeId) !== basis) return null; // moved under the plan: plan again
      const active = activeCascade(request.recipeId, db);
      if (active) {
        throw new ApiError(
          "run_in_flight",
          `${publishedMessage("run_in_flight")} The run in flight is ${active.id}.`,
          409,
        );
      }
      return createCascade(request.recipeId, plan!.kind, members, db);
    })();
  }
  if (!cascade || !plan) throw new ApiError("plan_changed", publishedMessage("plan_changed"), 409);
  const { kind, members, graph } = plan;
  void kind;

  const drive = driveCascade(scope, cascade.id, members, graph).finally(() => {
    driving.delete(cascade.id);
  });
  driving.set(cascade.id, drive);
  // Deliberately not awaited: a cascade outlives the request that started it,
  // exactly as a run does. An unhandled rejection here would kill the process,
  // so the drive itself never throws.
  void drive;
  return getCascade(cascade.id)!;
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
export async function startSingleRun(scope: AccountScope, recipeId: string, stepId: string): Promise<CascadeRun> {
  requireAccountScope(scope);
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    throw new ApiError("not_found", `No recipe with id "${recipeId}".`, 404);
  }
  const step = listSteps(recipeId).find((s) => s.id === stepId);
  if (!step) {
    throw new ApiError("not_found", `No step with id "${stepId}" in this recipe.`, 404);
  }
  const identity = identityOf(step);
  const cascade = recordUnderLock(recipeId, "single", [identity]);
  let resolveStarted!: (run: CascadeRun) => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<CascadeRun>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  // Start on the next microtask so the lifecycle is registered before
  // admission begins. A cancel that finds the durable pending member can then
  // wait for the same work that will either admit it or record its refusal.
  const lifecycle = Promise.resolve()
    .then(async () => {
      let job;
      try {
        job = await startStepRun(scope, stepId, { cascadeId: cascade.id });
      } catch (error) {
        if (isCancelled(cascade.id)) {
          if (!(error instanceof ApiError)) {
            console.error(
              `[operations] single cascade member ${stepId} failed at admission:`,
              error,
            );
          }
          setMember(cascade.id, stepId, {
            state: "failed",
            stoppedBy: error instanceof ApiError ? error.code : "internal",
            stoppedReason:
              error instanceof ApiError
                ? error.message
                : "An unexpected server error occurred.",
          });
          finishCascade(cascade.id, "cancelled", new Date().toISOString());
        } else {
          deleteCascade(cascade.id);
        }
        rejectStarted(error);
        return;
      }

      // A cancel accepted during admission owns the durable result. The job
      // exists now, so stop it here and finish the retained parent before the
      // cancel waiter answers.
      if (isCancelled(cascade.id)) {
        await cancelAdmittedMember(scope, cascade.id, stepId, job.id);
        setMember(cascade.id, stepId, {
          state: "failed",
          jobId: job.id,
          stoppedBy: "cancelled",
        });
        finishCascade(cascade.id, "cancelled", new Date().toISOString());
        resolveStarted(getCascade(cascade.id)!);
        return;
      }

      setMember(cascade.id, stepId, { state: "running", jobId: job.id });
      resolveStarted(getCascade(cascade.id)!);
      const graph: Graph = new Map([[stepId, []]]);
      await driveCascade(scope, cascade.id, [identity], graph, { stepId, jobId: job.id });
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
export function readCascade(id: string): CascadeView {
  const cascade = getCascade(id);
  if (!cascade) {
    throw new ApiError("not_found", `No cascade with id "${id}".`, 404);
  }
  // From the member rows, not from the jobs. A job is pruned once its
  // subject's history is deep enough, and a durable result that forgot what it
  // produced would be a worse record than none.
  const outputs = cascade.members
    .filter((m) => m.state === "succeeded" && m.output !== null)
    .map((m) => m.output!);
  return { ...cascade, outputs };
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
 */
export async function cancelCascade(scope: AccountScope, id: string): Promise<CascadeRun> {
  requireOwnedResource(scope, "cascade", id);
  const beforeFence = getCascade(id);
  if (!beforeFence) {
    throw new ApiError("not_found", `No cascade with id "${id}".`, 404);
  }
  // Terminal is not an error: cancel means *make sure this is not running*, and
  // for one that already finished that is true (G5's reasoning, one level up).
  if (beforeFence.outcome !== null) return beforeFence;

  raiseCancelFence(id);
  // The actionable snapshot is after the fence: every member it names was
  // admitted before cancellation won, and no later admission can join it.
  const cascade = getCascade(id) ?? beforeFence;
  const cancellations: { stepId: string; cancellation: RunCancellation }[] = [];
  for (const member of cascade.members) {
    if (member.state !== "running" || !member.jobId) continue;
    const job = getJob(member.jobId);
    if (job && !isTerminal(job.state)) {
      cancellations.push({
        stepId: member.stepId,
        cancellation: markAndSignalRunCancellation(scope, member.jobId),
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
    const stopped = getJob(cancellation.job.id) ?? cancellation.job;
    snapshotAttempt(id, stepId, stopped);
  }
  for (const { cancellation } of cancellations) pruneRunCancellation(cancellation);
  await Promise.all(
    cancellations.map(({ cancellation }) => waitForRunCancellation(cancellation)),
  );
  await cascadeSettled(id);
  return getCascade(id) ?? cascade;
}
