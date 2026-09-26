import { next as nextStep, nothing, notDone, type Direction, type History, type Step } from "./canvas-history";
import type { EditOutcome } from "./use-recipe-edits";

/**
 * A press of Undo or Redo: the lock met, what is pending landed as a
 * run lands it, then one step taken. Left the hook
 * (`use-canvas-history`) at review, so the press runs in a test over
 * the real coordinator with a fetch the test answers by hand. Nothing
 * of React here: the screen is read when the press runs, since a press
 * can wait on the wire and the canvas stays live meanwhile.
 */

/** What the press reads of the screen. */
export interface PressScreen {
  /** The canvas lock's reason while it is locked: a press
   * is inert and says it. */
  lockReason: string | null;
  /** The canvas's notice at its foot. */
  say: (text: string, tone?: "bad") => void;
  /** An open note editor is let commit under its own rule, so its changed
   * text is the newest step before the press takes one. */
  commitNoteEditor: () => void;
  /** The open panel's flush: what is typed lands first, as before a run,
   * and an invalid draft refuses with its own reason. */
  flushPanel: () => Promise<EditOutcome | null>;
  /** The delayed save of a completed move, sent now, so the record's own
   * write queues behind it rather than racing it. */
  settleLayoutSave: () => void;
}

export interface PressPorts {
  /** The screen as it stands now, or null once the canvas is gone. */
  screen: () => PressScreen | null;
  /** The coordinator's barrier: every change on the wire, awaited. */
  edits: { settled: () => Promise<EditOutcome | null> };
  /** The record as it stands. */
  record: () => History;
  /** A boundary drawn on the record: the next step merges with nothing. */
  seal: () => void;
  /** The step taken, through the applier its kind needs. */
  apply: (step: Step, direction: Direction) => Promise<void>;
}

/** Whether the canvas is locked now: said, and nothing else. A recipe
 * inverse meets the lock again at each of its own requests; a layout
 * step's write goes out from the press itself, so the press meets it
 * here, after its last wait. */
function locked(p: PressPorts): boolean {
  const s = p.screen();
  if (!s) return true;
  if (!s.lockReason) return false;
  s.say(s.lockReason, "bad");
  return true;
}

/** One press: the lock, the pending work, then the step. */
export async function runPress(direction: Direction, p: PressPorts): Promise<void> {
  const s = p.screen();
  if (!s) return;
  // Locked, a press is inert and exposes the lock's reason; the record
  // is untouched, so unlocking finds every step where it was.
  if (s.lockReason) {
    s.say(s.lockReason, "bad");
    return;
  }
  // What is pending lands first, as a run does. An open
  // note editor commits under its own rule and is captured at its
  // change, so a changed text is the newest step and is what this
  // press takes back.
  s.commitNoteEditor();
  // A valid unsent panel value is sent and becomes the newest step; an
  // invalid one refuses the press with its own reason and keeps its
  // value, the record intact. So does one the API refuses or one that
  // cannot be saved: the field keeps the value with the reason, and the
  // press is refused with it rather than taking an older step back over
  // a draft that never landed (a run over a rejected save is refused the
  // same way, barrier).
  const flushed = await s.flushPanel();
  if (flushed && (flushed.kind === "failed" || flushed.kind === "refused")) {
    s.say(notDone(direction, flushed.message), "bad");
    return;
  }
  // The canvas stays live across every wait, so the lock is met again
  // after each one, before anything is written: a value
  // sent before the lock lands under its own outcome, as a move admitted
  // before the lock does, and the press itself writes nothing.
  if (locked(p)) return;
  // The delayed save of a completed move goes now; the record's own
  // write queues behind it in the one writer.
  s.settleLayoutSave();
  // Edits on the wire land first, as the run's barrier waits for them,
  // and the barrier's answer is read as the run reads it: a change the
  // API refused or could not save while the press waited refuses the
  // press with its reason.
  const rejected = await p.edits.settled();
  if (rejected && (rejected.kind === "refused" || rejected.kind === "failed")) {
    s.say(notDone(direction, rejected.message), "bad");
    return;
  }
  if (locked(p)) return;
  const step = nextStep(p.record(), direction);
  // With nothing to take the press says so and does nothing: no step,
  // and no boundary either, so a run of arrow keys on one member goes
  // on as one step across it.
  if (!step) {
    s.say(nothing(direction));
    return;
  }
  // A press that takes a step is a boundary: a step made while the
  // inverse is on the wire starts its own, and can never fold into the
  // one being taken (which would leave the applied step nowhere in the
  // record). The seal comes after the flush, so a draft landing here
  // still joins its own field's session.
  p.seal();
  await p.apply(step, direction);
}
