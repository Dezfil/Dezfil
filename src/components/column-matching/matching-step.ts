import type { DataTable } from "../api";
import type { GeometryClient } from "../set-geometry/client";
import { applyEnabled, createPanelController, type PanelController, type PanelState } from "../set-geometry/panel-controller";

/** How a step ended: the set committed, or the file stays a plain table. */
export type StepOutcome = "confirmed" | "closed";

export interface MatchingStepState {
  /** The panel controller's state: the inspection, the choice, the
   * keyed preview, the refusal. The controls read it as the panel does. */
  panel: PanelState;
  /** Confirm is on: the controller's own Apply gate. */
  confirmable: boolean;
  /** The set is in flight: every way out of the step is inert. */
  busy: boolean;
  /** Set once, at the step's end; nothing resolves twice. */
  resolved: StepOutcome | null;
}

export interface MatchingStep {
  getState(): MatchingStepState;
  subscribe(listener: () => void): () => void;
  /** The reused controls drive the panel controller directly. */
  controller: PanelController;
  /** The hand-off at the step's end; the React binding sets it in an
   * effect so the dialog's latest closure takes the outcome. */
  configure(callbacks: { onResolved: (outcome: StepOutcome, table: DataTable) => void }): void;
  /** Open on the landed table: it has no geometry, so the opening
   * rule fills the controls from the API's first candidate or from the
   * merged fallback, and the projection stays implicit. */
  open(): Promise<void>;
  /** The controller's apply; on success the step resolves confirmed with
   * the set's table. A refusal leaves the step open, as the panel does. */
  confirm(): Promise<void>;
  /** Cancel, the dialog's close control and Escape all come through
   * here: refused (false) while the set is in flight, otherwise the
   * step closes and the file resolves as a plain table. */
  cancel(): boolean;
  /** The step's host is gone (the dialog unmounted under it), so nobody
   * is left to answer a refusal or to try again: the file's outcome is
   * decided here, once. With no set in flight the step closes plain; with
   * the set in flight its answer decides, confirmed on success and plain
   * on a refusal, so the table is never reported before its outcome is
   * known and never twice. */
  settle(): void;
}

/**
 * The step's own thin layer over panel controller (plan): the file the
 * step is for, the hand-off at its end, and the in-flight guard over
 * every way out. Everything else, the opening rule, the keyed previews,
 * Apply's gate, the refusal handling and the stale-revision re-read, is
 * the controller's, inherited unchanged. Pure of React, so its tests
 * hold it without a DOM.
 */
export function createMatchingStep({ client, table, onResolved: initial = () => {} }: {
  client: GeometryClient;
  table: DataTable;
  onResolved?: (outcome: StepOutcome, table: DataTable) => void;
}): MatchingStep {
  const controller = createPanelController({ client, name: table.name });
  let onResolved = initial;
  let resolved: StepOutcome | null = null;
  const listeners = new Set<() => void>();
  let state = derive();

  function derive(): MatchingStepState {
    const panel = controller.getState();
    return { panel, confirmable: applyEnabled(panel), busy: panel.applying, resolved };
  }
  const notify = () => {
    state = derive();
    for (const l of listeners) l();
  };
  controller.subscribe(notify);

  const resolve = (outcome: StepOutcome, landed: DataTable) => {
    if (resolved !== null) return;
    resolved = outcome;
    notify();
    onResolved(outcome, landed);
  };
  // The set committed: the table as the API returned it, geometry set.
  controller.configure({ onApplied: (result) => resolve("confirmed", result.table) });
  const cancel = () => {
    if (controller.getState().applying) return false;
    controller.cancel();
    resolve("closed", table);
    return true;
  };
  // Settled under a set in flight: the set's end decides. On success
  // onApplied has resolved it confirmed already; a refusal, which nobody
  // is left to answer, closes the file plain.
  let abandoned = false;
  const afterSet = () => {
    if (abandoned && resolved === null) cancel();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    controller,
    configure(callbacks) {
      onResolved = callbacks.onResolved;
    },
    open: () => controller.open({ geometryColumn: null, crsAssumed: table.crsAssumed }),
    confirm: () => controller.apply().then(afterSet),
    cancel,
    settle() {
      if (resolved !== null) return;
      if (controller.getState().applying) {
        abandoned = true;
        return;
      }
      cancel();
    },
  };
}
