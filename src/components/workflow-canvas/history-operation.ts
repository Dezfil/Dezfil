import type { WorkflowStep } from "../workflow-model";
import type { Position, Positions } from "./arrange";
import { serverUnreachable } from "../failure-copy";
import { done, dropped, holds, notDone, outrun, reasons, rekeyed, settled, taken, type Direction, type History, type RecipeStep } from "./canvas-history";
import type { ReadStep } from "./history-inverses";
import { applyRecipeStep } from "./history-recipe";
import type { EditOutcome, RecipeCoordinator, RecipeEdits, RemovalOutcome } from "./use-recipe-edits";

/**
 * The history operation: one recipe step put back or forward, as one
 * resumable run. It reads the workflow first, settles the record against
 * what the read says has run, asks whether the record still holds the
 * very step it was given, waits for a member the run in flight still
 * holds, and only then applies the step through the appliers; when the
 * workflow accepts, the step crosses and the notice says so. A failure
 * on the way (the read, or any request the appliers make) offers the
 * frame's whisper **this operation's own resume**, never the
 * coordinator's re-issue of a raw call: a resumed operation reads again
 * and applies no stage twice, and it meets the lock again before it
 * sends anything. Once the step has landed or been
 * dropped, a stale Retry does nothing.
 *
 * Left the hook (`use-canvas-history`) at the refuters' round, so the
 * operation runs in a test over the real coordinator with a fetch the
 * test answers by hand. Nothing of React here: the screen's ports are
 * read when the operation runs and again when it resumes, since a Retry
 * can come long after the press.
 */

/** What the operation reads of the screen, at each attempt. */
export interface OperationScreen {
  /** The canvas lock's reason while it is locked: nothing is sent and
   * the reason is said, the step left exactly where it is. */
  lockReason: string | null;
  /** The canvas's notice at its foot. */
  say: (text: string, tone?: "bad") => void;
  /** The frame's whisper: a failure this operation owns, with the Retry
   * that resumes it, as any edit's failure offers. */
  failed: (message: string, retry: () => void) => void;
  /** The failure this operation owned is over: the step landed or left
   * the record, so the whisper's Retry has nothing left to resume. */
  recovered: () => void;
  /** The word a member of the run in flight wears while unsettled, or null. */
  runWord: (nodeId: string) => string | null;
  /** The positions the stored layout document holds. */
  stored: () => Positions;
  /** A node's tile leaves the canvas, through a confirmed removal's tail. */
  dropNode: (nodeId: string) => void;
  /** A node's tile takes its spot, by the one road a new node travels. */
  placeNode: (nodeId: string, position: Position) => void;
}

export interface OperationPorts {
  /** The coordinator the screen made: the unrecorded road an inverse
   * travels, every request on it carrying the operation's own resume. */
  edits: RecipeCoordinator;
  /** The screen as it stands now, or null once the canvas is gone. */
  screen: () => OperationScreen | null;
  /** The recipe as it stands: read before the first attempt and before every resume. */
  read: () => Promise<ReadStep[] | null>;
  /** The record as it stands, and the record after a move. */
  record: () => History;
  put: (next: History) => void;
  /** A node's own word for the notice. */
  labelOf: (nodeId: string) => string;
  /** The newest answer this page has for a node is this one now. */
  answered: (step: WorkflowStep) => void;
  /** The page's answer for a node is forgotten: it has left the workflow. */
  forget: (nodeId: string) => void;
  /** A resume queues behind whatever press is in flight: one at a time,
   * each landing before the next is taken. */
  enqueue: (job: () => Promise<void>) => void;
}

/** The recipe as it stands, or null when it could not be read. Every
 * inverse reads before its first attempt and before every Retry, so no
 * stage is ever applied twice. */
export async function readRecipe(id: string): Promise<ReadStep[] | null> {
  try {
    const response = await fetch(`/api/recipes/${id}`);
    if (!response.ok) return null;
    return ((await response.json()) as { recipe: { steps: ReadStep[] } }).recipe.steps;
  } catch {
    return null;
  }
}

/** The lock, met again at every request the appliers make.
 * An inverse reads the workflow before it sends anything and a
 * restoration is several requests, while the canvas stays live across
 * each wait: a lock turned on during the read, or between two stages,
 * must stop the next request rather than the one after it. Locked, a
 * call sends nothing and answers as a refusal the page itself raises,
 * classed transient, so the step is kept and unlocking finds it; the
 * notice says the lock's reason. */
export const LOCKED = "locked";
export function lockGated(edits: RecipeEdits, lockReason: () => string | null): RecipeEdits {
  const refused = (): Extract<EditOutcome, { kind: "refused" }> | null => {
    const reason = lockReason();
    return reason ? { kind: "refused", code: LOCKED, message: reason } : null;
  };
  return {
    add: (input, note) => Promise.resolve(refused() ?? edits.add(input, note)),
    edit: (stepId, parameters, note) => Promise.resolve(refused() ?? edits.edit(stepId, parameters, note)),
    discard: (stepId) => Promise.resolve(refused() ?? edits.discard(stepId)),
    remove: (stepId): Promise<RemovalOutcome> => Promise.resolve(refused() ?? edits.remove(stepId)),
    reorder: (stepId, ordinal) => Promise.resolve(refused() ?? edits.reorder(stepId, ordinal)),
    drafts: edits.drafts,
    idle: edits.idle,
    settled: edits.settled,
  };
}

/** The same calls, each answer read as it lands: a failure to answer
 * among them is noted, so the operation knows the whisper holds one of
 * its own. */
function noting(edits: RecipeEdits, onFailed: () => void): RecipeEdits {
  const seen = <T extends EditOutcome | RemovalOutcome>(answer: Promise<T>): Promise<T> =>
    answer.then((outcome) => {
      if (outcome.kind === "failed") onFailed();
      return outcome;
    });
  return {
    add: (input, note) => seen(edits.add(input, note)),
    edit: (stepId, parameters, note) => seen(edits.edit(stepId, parameters, note)),
    discard: (stepId) => seen(edits.discard(stepId)),
    remove: (stepId) => seen(edits.remove(stepId)),
    reorder: (stepId, ordinal) => seen(edits.reorder(stepId, ordinal)),
    drafts: edits.drafts,
    idle: edits.idle,
    settled: edits.settled,
  };
}

/** One recipe step put back or forward: the first attempt, run now; every
 * Retry the whisper offers resumes it through the queue. */
export function runInverse(step: RecipeStep, direction: Direction, p: OperationPorts): Promise<void> {
  // Once the step has landed or been dropped, a stale Retry does
  // nothing: no second node, nothing moved twice.
  let finished = false;
  // Whether a failure of this operation's own reached the whisper: a
  // Retry that then finds nothing left to send (the request landed, its
  // answer lost) makes no request, so no coordinator callback ever
  // clears it, and the frame kept "Couldn't save · Retry" beside a
  // notice saying Undone (found at review). When the
  // operation is over on any path, the screen is told.
  let failedOnce = false;
  const finish = (s: OperationScreen) => {
    finished = true;
    if (failedOnce) s.recovered();
  };
  const attempt = async (): Promise<void> => {
    // A Retry can come long after the press: the screen's ports are
    // read again rather than held from it.
    const s = p.screen();
    if (!s || finished) return;
    // And so is the lock. A Retry re-enters here directly, so the guard
    // a press holds must hold again before an inverse resumes: locked,
    // nothing is sent and the reason is said, with the step left
    // exactly where it is, so unlocking finds it.
    if (s.lockReason) {
      s.say(s.lockReason, "bad");
      return;
    }
    const read = await p.read();
    if (!read) {
      // The read is part of the inverse, so its failure is the
      // inverse's: the notice says why and the frame's whisper offers
      // Retry, which resumes this operation from a fresh read.
      const message = serverUnreachable("read the workflow");
      s.say(notDone(direction, message), "bad");
      failedOnce = true;
      s.failed(message, resume);
      return;
    }
    // A run settles what it produced, member by member:
    // a step whose node wrote its dataset since leaves the record on
    // both sides, and the next press takes the step before it.
    p.put(settled(p.record(), read.map((r) => ({ id: r.id, lastSuccessAt: r.lastSuccessAt }))));
    // The settle can take this very step away; a step made meanwhile
    // cannot, and must not be mistaken for it: the record is asked
    // whether it still holds *this* step, never what stands newest. A
    // step gone from the record was taken by one of two things, each
    // with its own words: a run that wrote the node's
    // dataset, which the read shows, or a fresh step made while this
    // one was on the wire, which forgets the undone side, and then
    // nothing ran.
    if (!holds(p.record(), direction, step)) {
      finish(s);
      const reason = outrun(step, read) ? reasons.ranSince(p.labelOf(step.nodeId)) : reasons.forgotten(step.label);
      s.say(notDone(direction, reason), "bad");
      return;
    }
    // A member the run in flight still holds is not edited from the
    // canvas: the step waits for it.
    for (const nodeId of Object.keys(step.watermarks)) {
      const word = s.runWord(nodeId);
      if (word) {
        s.say(notDone(direction, reasons.inRun(p.labelOf(nodeId), word)), "bad");
        return;
      }
    }
    // Every request the appliers make carries this operation's resume,
    // with the call itself: a failure among them offers the whisper
    // this resume and never another caller's Retry, whatever else is
    // on the wire beside it. And every one meets the lock as it is made:
    // the guard above held before the read, and the canvas could have
    // been locked since.
    const result = await applyRecipeStep(step, direction, read, {
      edits: noting(lockGated(p.edits.owned(resume), () => p.screen()?.lockReason ?? null), () => {
        failedOnce = true;
      }),
      labelOf: p.labelOf,
      stored: s.stored,
      dropNode: s.dropNode,
      answered: p.answered,
      forget: p.forget,
    });
    if (result.kind === "refused") {
      // A refusal that will pass later keeps the step for the next
      // press; one that cannot drops it with the reason.
      if (result.verdict === "drop") {
        finish(s);
        p.put(dropped(p.record(), direction, step));
      }
      // A failure to answer among the requests offered the whisper this
      // resume as it happened; a request that followed it (a
      // restoration's compensation) said saving and saved through the
      // same whisper, taking that Retry with it while the step stands.
      // The failure is the operation's last word, said again here.
      if (result.failed && result.verdict === "keep") s.failed(result.reason, resume);
      s.say(notDone(direction, result.reason), "bad");
      return;
    }
    finish(s);
    // The step crosses first, and the re-key follows it: a re-key makes
    // fresh step objects, and the one this operation applied would no
    // longer be findable among them.
    p.put(taken(p.record(), direction, step));
    if (result.rekey) p.put(rekeyed(p.record(), result.rekey.from, result.rekey.to));
    s.say(result.say ? `${done(direction, step)}. ${result.say}` : done(direction, step));
    // The tile takes its spot once the record names the node that came
    // back, so the placement joins that node's own step.
    if (result.place) s.placeNode(result.place.id, result.place.position);
  };
  const resume = () => p.enqueue(attempt);
  return attempt();
}
