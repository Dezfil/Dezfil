"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DataTable } from "../api";
import { geometryClient, type GeometryClient } from "../set-geometry/client";
import { createMatchingStep, type MatchingStep, type MatchingStepState, type StepOutcome } from "./matching-step";

const subscribeNothing = () => () => {};
const nothing = () => null;

/**
 * The dialog's handle on its pending step: one step per held table, none while no table is held,
 * opened when it is created, its state read through the external-store contract. The hand-off is
 * configured in an effect so the dialog's latest closure takes the outcome (the use-set-geometry-
 * panel manner), and the step object is stable for the table's lifetime, so hiding the step on
 * another source (the * placeholder) keeps the person's draft choice. The dialog holds it above the
 * step's pane, so the close guard can read whether the set is in flight.
 */
export function useMatchingStep({ table, onResolved, client = geometryClient }: {
  table: DataTable | null;
  onResolved: (outcome: StepOutcome, table: DataTable) => void;
  client?: GeometryClient;
}): { state: MatchingStepState | null; step: MatchingStep | null } {
  // The step is the table's: a new held table is a new step; no table, no step.
  const step = useMemo(() => (table ? createMatchingStep({ client, table }) : null), [client, table]);
  useEffect(() => {
    step?.configure({ onResolved });
  }, [step, onResolved]);
  useEffect(() => {
    void step?.open();
  }, [step]);
  const state = useSyncExternalStore(step?.subscribe ?? subscribeNothing, step?.getState ?? nothing, step?.getState ?? nothing);
  return { state, step };
}
