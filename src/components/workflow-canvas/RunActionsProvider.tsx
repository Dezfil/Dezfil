"use client";

import { useMemo, useState } from "react";
import { RunActionsContext, type RunActions } from "./run-context";
import type { WorkflowRunner } from "./use-workflow-run";

/** The panel's run actions: a node's own run
 * started here with its refusal kept per node; a run from a node handed
 * to the screen, which asks first when it is wide. */
export function RunActionsProvider({
  runner,
  onRunFrom,
  children,
}: {
  runner: WorkflowRunner;
  onRunFrom: (from: { id: string; label: string }) => void;
  children: React.ReactNode;
}) {
  const [refusals, setRefusals] = useState<Record<string, { message: string; retry: (() => void) | null }>>({});
  const actions = useMemo<RunActions>(
    () => ({
      runNode: (m) => {
        // The refusal and its Retry are this owner's: Retry runs the node
        // again through here, so the notice follows the new answer.
        const attempt = () => {
          setRefusals((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== m.step.id)));
          void runner.runNode(m.step.id).then((outcome) => {
            if (outcome.kind === "refused") setRefusals((r) => ({ ...r, [m.step.id]: { message: outcome.message, retry: outcome.retryable ? attempt : null } }));
            else if (outcome.kind === "save_failed") setRefusals((r) => ({ ...r, [m.step.id]: { message: `Couldn't save the change, so nothing started. ${outcome.message}`, retry: null } }));
          });
        };
        attempt();
      },
      // The node as the canvas names it: its operation and its dataset.
      runFrom: (m) => onRunFrom({ id: m.step.id, label: m.outputName ? `${m.label} · ${m.outputName}` : m.label }),
      refusalFor: (stepId) => refusals[stepId] ?? null,
      dismissRefusal: (stepId) => setRefusals((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== stepId))),
    }),
    [onRunFrom, refusals, runner],
  );
  return <RunActionsContext.Provider value={actions}>{children}</RunActionsContext.Provider>;
}
