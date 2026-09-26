import type { TurnPhase } from "./turn-phase";

/**
 * Where focus lands when a control is disabled or removed under it
 * (hand-off table), extracted from `AssistantComposer.tsx` at the feature
 * that grew it: adds the picker, which is disabled at submission exactly as
 * the input is, and a rule with five cases inside an effect cannot be
 * walked.
 *
 * A control that loses focus this way drops it to the body with no blur, so
 * the *last landing* is what decides. Focus that is anywhere else is never
 * taken — that is a rule, not an omission, and it is checked.
 */

export type FocusPlace = "input" | "slot" | "card" | "picker" | "pane" | "elsewhere";
export type FocusLanding = "input" | "slot" | null;

/** Classify the element focus landed on. The picker is read before the pane
 * because it is inside it, and a picker read as "pane" would get no hand-off
 * at submission. */
export function focusPlace(target: Element | null, isInput: boolean, isSlot: boolean): FocusPlace {
  if (isInput) return "input";
  if (isSlot) return "slot";
  if (!target) return "elsewhere";
  if (target.closest("[data-confirmation]")) return "card";
  if (target.closest("[data-model-choice]")) return "picker";
  if (target.closest("[data-assistant-pane]")) return "pane";
  return "elsewhere";
}

const working = (phase: TurnPhase) => phase === "executing" || phase === "parked";

export function focusLanding(before: TurnPhase, phase: TurnPhase, focused: FocusPlace): FocusLanding {
  if (before === phase) return null;
  // Submission disabled the composer, the picker included, under the
  // person's focus: Stop takes it.
  if (working(phase) && before === "idle" && (focused === "input" || focused === "picker")) return "slot";
  // Confirm or Cancel removed the card's control under their focus and a
  // continuation started: Stop takes it.
  if (phase === "executing" && before === "parked" && focused === "card") return "slot";
  // Settlement turned a focused Stop into a disabled Send, or the settling
  // run's outcome door left under focus: the enabled input takes it. The
  // picker is not here — it was disabled at submission and its focus has
  // already gone to Stop, so there is nothing of its to hand back.
  if (phase === "idle" && (focused === "slot" || focused === "pane" || focused === "card")) return "input";
  return null;
}
