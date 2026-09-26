"use client";

import { useSyncExternalStore } from "react";

/**
 * Select mode: the armed state that lets the next eligible layer card — or a
 * rendered feature on the map — choose a tool input's table.
 *
 * **A module store, for the same reason the card notes use one**: the form
 * that arms it lives in the drawer, and the surfaces that answer it — the
 * layer list and the map canvas — are sibling trees. One publisher, many
 * readers, no threading through the builder the decomposition rule protects.
 *
 * **The eligibility rule is the arm's own closure** (D5): the picker knows
 * its input's accepted classes and the table list, so the store carries a
 * resolver rather than re-deriving either. An ineligible layer leaves the
 * mode armed and puts the reason where the picker renders it.
 *
 * **Escape disarms, and is consumed in the capture phase** — ahead of every
 * bubble listener whatever their registration order, so the drawer's own
 * deferred check reads the verdict reliably. One press, one level;
 * proven live after the bubble-order version failed in the browser.
 */

export interface ArmedPick {
  /** The input's label, for the armed state's own words. */
  label: string;
  /**
   * Try a layer. Returns null on success — the pick was consumed and the
   * mode disarmed — or the worded refusal, which leaves the mode armed.
   */
  tryLayer: (layer: { id: string; name: string; sql: string }) => string | null;
}

interface PickState {
  armed: ArmedPick | null;
  /** The last refusal's sentence, for the picker's hint area. */
  refusal: string | null;
}

let state: PickState = { armed: null, refusal: null };
const listeners = new Set<() => void>();

function publish(next: PickState) {
  state = next;
  for (const listener of listeners) listener();
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  disarmPick();
}

/** Draw mode and Select cannot be armed together. The draw store
 * registers here, so arming Select disarms an armed draw tool — the
 * mirror of the draw store calling disarmPick when a tool arms. */
let armObserver: (() => void) | null = null;
export function onPickArmed(observer: (() => void) | null): void {
  armObserver = observer;
}

export function armPick(pick: ArmedPick): void {
  if (state.armed === null)
    document.addEventListener("keydown", onEscape, { capture: true });
  armObserver?.();
  publish({ armed: pick, refusal: null });
}

export function disarmPick(): void {
  if (state.armed !== null)
    document.removeEventListener("keydown", onEscape, { capture: true });
  publish({ armed: null, refusal: null });
}

/**
 * Offer a layer to the armed pick. Returns true when the click was consumed
 * — a success or a refusal alike, because either way the gesture belonged
 * to the picker, not to selection, cluster zoom or a popup.
 */
export function offerLayer(layer: {
  id: string;
  name: string;
  sql: string;
}): boolean {
  const armed = state.armed;
  if (!armed) return false;
  const refusal = armed.tryLayer(layer);
  if (refusal === null) {
    document.removeEventListener("keydown", onEscape, { capture: true });
    publish({ armed: null, refusal: null });
  } else {
    publish({ ...state, refusal });
  }
  return true;
}

/** The armed pick's label, readable outside React — for unmount cleanup. */
export function armedPickLabel(): string | null {
  return state.armed?.label ?? null;
}

const read = () => state;
const readServer = (): PickState => ({ armed: null, refusal: null });

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePickMode(): PickState {
  return useSyncExternalStore(subscribe, read, readServer);
}
