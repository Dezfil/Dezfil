"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { SaveUnit, UnitFocus, UnitSnapshot } from "./save-unit";
import { useGuardEntry } from "./settings-guard";

/**
 * A card's save unit, made once for the card's life: its snapshot as
 * React state, its unsaved text reported to the leave guard under the
 * card's title, and its leaving (Undo and the Saved marks go, a settling
 * number is sent) when the card goes.
 */
export function useSaveUnit(id: string, create: () => SaveUnit): [SaveUnit, UnitSnapshot] {
  const [unit] = useState(create);
  const snapshot = useSyncExternalStore(listener => unit.subscribe(listener), () => unit.snapshot, () => unit.snapshot);
  useGuardEntry(id, snapshot.dirty, unit.title);
  useEffect(() => () => unit.leave(), [unit]);
  return [unit, snapshot];
}

/** Moves focus where the unit asks, once per request: a field by its key
 * (`data-unit-key`), the head's Undo or Reset, or the card's heading. */
export function useUnitFocus(root: RefObject<HTMLElement | null>, focus: UnitFocus | null) {
  const done = useRef(0);
  useEffect(() => {
    if (!focus || focus.seq === done.current) return;
    done.current = focus.seq;
    const selector = focus.to === "field" ? `[data-unit-key="${focus.key}"]` : focus.to === "heading" ? "h2" : `[data-unit-slot="${focus.to}"]`;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [root, focus]);
}
