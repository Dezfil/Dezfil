"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DataTable } from "../api";
import type { MatchingStep, StepOutcome } from "./matching-step";
import { needsStep } from "./needs-step";

/** A URL result held for the step. */
export interface UrlHold {
  table: DataTable;
  /** The upload step pending when the result arrived, by the engine's
   * id, or null: the step this one waits behind. A later result waits
   * its turn, as the batch does. */
  behind: number | null;
}

/**
 * The URL road's hold. The From URL pane has no queue: the
 * dialog wraps its hand-off, and an answer that needs the step is held
 * here until the step's end, when the table is carried to the host once,
 * as it stands, set or plain. The host's callback closes the host, so it
 * must fire exactly once per file, and it must fire: a result whose
 * fetch finishes after the dialog closed reaches nobody who can show a
 * step, so it goes to the host directly; a
 * result still held when the dialog unmounts, under a host that closed
 * on its batch's settlement or on its own account, is handed over on
 * the way out, so settlement never discards it. When a step
 * is open on the held table at that unmount, the step settles it
 * instead, so the host's closing and a set in flight share one
 * decision and the table is delivered once, with its real outcome.
 */
export function useUrlHold({ onTableCreated, pendingUploadStep, activeStep }: {
  onTableCreated: (table: DataTable) => void;
  /** The engine's live pending step, read at the moment a result arrives. */
  pendingUploadStep: () => number | null;
  /** The step open on the held table, read at the unmount; null while
   * the hold waits behind the engine's step, when no step is open on it. */
  activeStep: () => Pick<MatchingStep, "settle"> | null;
}): {
  /** The result whose step is pending or waiting, or none. */
  held: UrlHold | null;
  /** The pane's landing: held for the step, or handed on at once. */
  landed: (table: DataTable) => void;
  /** The step's end: the table carried once, as it stands. */
  resolved: (outcome: StepOutcome, table: DataTable) => void;
} {
  const [held, setHeld] = useState<UrlHold | null>(null);
  // The hold's truth for the ways out that run outside a render: the
  // unmount reads it, and a resolution clears it before the host closes.
  const holding = useRef<UrlHold | null>(null);
  // The host's latest closure takes every hand-off, however late.
  const handOff = useRef(onTableCreated);
  const stepOn = useRef(activeStep);
  useEffect(() => {
    handOff.current = onTableCreated;
    stepOn.current = activeStep;
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const left = holding.current;
      if (!left) return;
      // A step open on the table decides its outcome and carries it
      // through `resolved`, now or when its set answers; without one the
      // table goes over as it stands.
      const step = stepOn.current();
      if (step) {
        step.settle();
        return;
      }
      holding.current = null;
      handOff.current(left.table);
    };
  }, []);
  const landed = useCallback((table: DataTable) => {
    if (!mounted.current || !needsStep(table)) {
      handOff.current(table);
      return;
    }
    const hold = { table, behind: pendingUploadStep() };
    holding.current = hold;
    setHeld(hold);
  }, [pendingUploadStep]);
  const resolved = useCallback((_outcome: StepOutcome, table: DataTable) => {
    holding.current = null;
    setHeld(null);
    handOff.current(table);
  }, []);
  return { held, landed, resolved };
}
