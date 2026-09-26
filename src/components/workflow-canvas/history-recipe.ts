import type { Position } from "./arrange";
import type { WorkflowStep } from "../workflow-model";
import { reasons, type Definition, type Direction, type RecipeStep } from "./canvas-history";
import { classifyRefusal, definitionStage, removalStage, restoreStages, type ReadStep, type Restore, type Verdict } from "./history-inverses";
import type { EditOutcome, RecipeEdits, RemovalOutcome } from "./use-recipe-edits";

/**
 * The recipe appliers: a recipe step put back through the operation that
 * reverses it, under that operation's rules, as if the user had done it.
 * Nothing new is asked of the API; every inverse travels the
 * coordinator's unrecorded road.
 *
 * Every inverse of more than one request is **resumable**: the decisions
 * in `history-inverses` read a fresh recipe and say which of its stages
 * have landed, so a first attempt and every Retry apply exactly what is
 * missing and no stage twice. A node created under a lost answer is
 * adopted rather than added again; a restoration whose place in the
 * order is refused takes the node just added back out, since a producer
 * standing after its readers is not a workflow the engine accepts.
 *
 * What is applied here, and what the caller does: the applier makes the
 * requests and moves the screen where a tile leaves it; the record's own
 * moves (the step taken, dropped or re-keyed) and the notice belong to
 * the caller, which holds the record.
 */

/** The identity a lost answer left behind, kept per step so a Retry
 * adopts the node an earlier attempt created rather than adding a
 * second. Keyed by the step object itself, so it lives exactly as long
 * as the step does. */
const adopted = new WeakMap<RecipeStep, string>();

/** The ids the workflow held when a step's restoration began, kept per
 * step so every Retry judges adoption against the same baseline: a node
 * absent from it is one this restoration created. A restoration that
 * lands re-keys the record onto a fresh step object, so the next one
 * starts from the read it finds. */
const baselines = new WeakMap<RecipeStep, string[]>();

/** The steps whose own removal has been sent at least once. On a resume,
 * a node gone from the read is one that removal took with its answer
 * lost, and the stage has landed; on a first attempt a node already gone
 * was taken by another tab or an agent, nothing of this record took it,
 * and the step cannot pass: it is dropped with the reason (behaviours 2
 * and 3), since crossing it would let a redo bring back a node somebody
 * else removed. Keyed by the step object, as the two above. */
const removalSent = new WeakSet<RecipeStep>();

const SUPERSEDED = "Another change landed over it. Try again.";
const NO_ANSWER = "The workflow did not say which node it added. Try again.";

export interface RecipePorts {
  /** The coordinator's unrecorded road: an inverse is no step of its own. */
  edits: RecipeEdits;
  /** A node's own word for the notice. */
  labelOf: (nodeId: string) => string;
  /** The positions the stored layout document holds: which stages of a
   * restoration are still to do. */
  stored: () => Record<string, Position>;
  /** A node's tile leaves the canvas through the tail a confirmed
   * removal already has (its placement forgotten, its position out of
   * the next write). */
  dropNode: (nodeId: string) => void;
  /** The newest answer this page has for a node, so the next step made
   * on it is measured from what the inverse wrote, not from what it
   * wrote over. */
  answered: (step: WorkflowStep) => void;
  forget: (nodeId: string) => void;
}

export type ApplyResult =
  | {
      kind: "done";
      /** A node came back under a fresh identity: every step naming the
       * old one names the new one now. */
      rekey?: { from: string; to: string };
      /** The spot the tile takes, by the one road a new node travels. */
      place?: { id: string; position: Position };
      /** A sentence the notice adds after the step's own words. */
      say?: string;
    }
  | ({
      kind: "refused";
      /** The refusal is a failure to answer, whose Retry the whisper
       * offers: said again by the caller when a request that followed it
       * (a compensation) spoke over it. */
      failed?: boolean;
    } & Verdict);

type Refused = Exclude<EditOutcome, { kind: "accepted" }> | Exclude<RemovalOutcome, { kind: "accepted" }>;

/** A refusal classed in context, not by status alone: one that will pass
 * later keeps the step for the next press, one that cannot drops it. */
function verdictOf(outcome: Refused): Extract<ApplyResult, { kind: "refused" }> {
  if (outcome.kind === "superseded") return { kind: "refused", verdict: "keep", reason: SUPERSEDED };
  if (outcome.kind === "failed") return { kind: "refused", failed: true, ...classifyRefusal({ kind: "failed", message: outcome.message }) };
  return { kind: "refused", ...classifyRefusal({ kind: "refused", code: outcome.code, message: outcome.message, status: outcome.status }) };
}

/** A node the record put in the workflow leaves it again: an add or a
 * paste undone, a removal redone. Without the removal confirmation,
 * since such a node has never run. */
async function takeAway(step: RecipeStep, read: ReadStep[], p: RecipePorts): Promise<ApplyResult> {
  const nodeId = step.nodeId;
  if (removalStage(read, nodeId) === "remove") {
    removalSent.add(step);
    const outcome = await p.edits.remove(nodeId);
    if (outcome.kind !== "accepted") return verdictOf(outcome);
  } else if (!removalSent.has(step)) {
    // Gone before this record sent anything for it: not this step's doing.
    return { kind: "refused", verdict: "drop", reason: reasons.gone(p.labelOf(nodeId)) };
  }
  p.forget(nodeId);
  // Its position leaves with the next layout write, as a removal's does.
  p.dropNode(nodeId);
  return { kind: "done" };
}

/** A node comes back: the add, its former place in the order, and the
 * spot its tile takes, each skipped when the read says it has landed.
 * All or nothing: an order the engine refuses takes the
 * node just added back out and the undo is refused. */
async function bringBack(step: RecipeStep, want: Restore, read: ReadStep[], p: RecipePorts): Promise<ApplyResult> {
  const { id, pending } = restoreStages(read, p.stored(), want);
  let nodeId = id;
  if (pending.includes("add")) {
    const outcome = await p.edits.add({ operation: want.operation, parameters: want.parameters });
    if (outcome.kind !== "accepted") return verdictOf(outcome);
    if (!outcome.step) return { kind: "refused", verdict: "keep", reason: NO_ANSWER };
    nodeId = outcome.step.id;
    adopted.set(step, nodeId);
    p.answered(outcome.step);
  }
  if (nodeId === null) return { kind: "refused", verdict: "keep", reason: NO_ANSWER };
  if (pending.includes("order") && want.ordinal !== null) {
    const outcome = await p.edits.reorder(nodeId, want.ordinal);
    if (outcome.kind !== "accepted") {
      // The compensation finishes before the next press proceeds: the
      // node just added goes again, so nothing of the undo stands. Until
      // it does the step is **kept**, whatever the order's own verdict
      // was: dropping it would leave the added node standing with nothing
      // left in the record to take it away, and its Retry, which resumes
      // this step, gone with it. The order's own verdict is returned
      // once the compensation has landed, and a failure among it says so,
      // since the compensation's own saving and saved spoke over the
      // whisper's Retry meanwhile (found at review).
      const back = await p.edits.remove(nodeId);
      if (back.kind !== "accepted") return { ...verdictOf(back), verdict: "keep" };
      adopted.delete(step);
      p.forget(nodeId);
      return verdictOf(outcome);
    }
  }
  return {
    kind: "done",
    rekey: nodeId === step.nodeId ? undefined : { from: step.nodeId, to: nodeId },
    place: want.position && !(nodeId in p.stored()) ? { id: nodeId, position: want.position } : undefined,
  };
}

/** A node's definition put back as it was before the step: on a node
 * that has not run its active definition, on one that has the proposal
 * it had, or no proposal, which is what Discard edit makes of it. */
async function putDefinition(nodeId: string, target: Definition, read: ReadStep[], p: RecipePorts): Promise<ApplyResult> {
  const stage = definitionStage(read, nodeId, target);
  if (stage.stage === "gone") return { kind: "refused", verdict: "drop", reason: reasons.gone(p.labelOf(nodeId)) };
  if (stage.stage === "landed") return { kind: "done" };
  const outcome = stage.stage === "discard" ? await p.edits.discard(nodeId) : await p.edits.edit(nodeId, stage.parameters);
  if (outcome.kind !== "accepted") return verdictOf(outcome);
  if (outcome.step) p.answered(outcome.step);
  return { kind: "done" };
}

/** One recipe step put back, or forward: the read decides what is left
 * to do, and the result says what the record must do with the step. */
export async function applyRecipeStep(step: RecipeStep, direction: Direction, read: ReadStep[], p: RecipePorts): Promise<ApplyResult> {
  const op = step.op;
  const restore = (ordinal: number | null, parameters: Record<string, unknown>, operation: string, position: Position | null) => {
    // Taken from the first attempt's read and kept for every Retry: the
    // nodes that stood before this restoration began.
    let baseline = baselines.get(step);
    if (!baseline) {
      baseline = read.map((s) => s.id);
      baselines.set(step, baseline);
    }
    return bringBack(step, { operation, parameters, ordinal, position, adopted: adopted.get(step) ?? null, baseline }, read, p);
  };
  if (op.kind === "add") {
    // An add undone removes the node it added; redone, a node with the
    // same operation and values is added again, appended as an add is.
    return direction === "undo" ? takeAway(step, read, p) : restore(null, op.parameters, op.operation, op.position);
  }
  if (op.kind === "remove") {
    if (direction === "redo") return takeAway(step, read, p);
    const result = await restore(op.ordinal, op.parameters, op.operation, op.position);
    // The dataset the removal deleted is not restored: the node is back,
    // never run, and the notice says so (open question 3).
    return result.kind === "done" && op.dataset === "deleted" ? { ...result, say: reasons.runAgain } : result;
  }
  if (op.kind === "relink") {
    // The old holder's link goes back first, then the moving node's
    // detach; forward, the same road the move itself took.
    const halves =
      direction === "undo"
        ? [
            { nodeId: op.holder.nodeId, target: op.holder.before },
            { nodeId: op.taker.nodeId, target: op.taker.before },
          ]
        : [
            { nodeId: op.taker.nodeId, target: op.taker.after },
            { nodeId: op.holder.nodeId, target: op.holder.after },
          ];
    for (const [i, half] of halves.entries()) {
      const result = await putDefinition(half.nodeId, half.target, read, p);
      if (result.kind !== "refused") continue;
      // The first half refused: nothing has changed. The second: both
      // nodes keep a link to the same producer, a state the workflow
      // accepts, and the notice says which half stands.
      return i === 0 ? result : { ...result, reason: `${p.labelOf(half.nodeId)} still holds the link. ${result.reason}` };
    }
    return { kind: "done" };
  }
  return putDefinition(step.nodeId, direction === "undo" ? op.before : op.after, read, p);
}
