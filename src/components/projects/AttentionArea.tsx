"use client";

import { useMemo } from "react";
import { OwnerPill } from "../sharing/PeopleMarks";
import type { PersonLabel } from "../sharing/people";
import { AsyncState } from "../ui/AsyncState";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { PlayIcon } from "../ui/icons";
import { outputNameOf } from "../workflow-canvas/graph";
import {
  RunConfirmDialog,
  type PlanRow,
} from "../workflow-canvas/RunConfirmDialog";
import { useRunConfirm } from "../workflow-canvas/use-run-confirm";
import { useWorkflowRun } from "../workflow-canvas/use-workflow-run";
import { nodeWord, type WorkflowListing } from "../workflow-model";
import type { AttentionRow } from "./home-model";
import styles from "./ProjectHome.module.css";

/**
 * The home's attention area: one row per member workflow the server
 * classifies as to-run-again, each Run naming its target and driving
 * the SAME planning-and-confirmation interaction the canvas owns —
 * never a second path. Another host may ask for more, per row: the
 * owner's pill on someone else's workflow, Run withheld until the read
 * that says who may run it has answered, and runners that read no runs.
 * The project home asks for none of it.
 */

/** A Run waiting on the projects read: the pending line in its place
 * meanwhile, the read's failure note with Try again when it failed. */
export type WithheldRun =
  | { status: "pending" }
  | { status: "failed"; error: string; retry: () => void };

/** A row as a host draws it. */
export interface AttentionRowView extends AttentionRow {
  /** Someone else's workflow: the owner's pill after its name. */
  owner?: PersonLabel | null;
  /** Run is not offered until the projects read answers. */
  withheld?: WithheldRun | null;
}

function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3 2.5 20h19L12 3ZM12 10v4M12 17.2v.3" />
    </svg>
  );
}

function AttentionRun({
  row,
  workflow,
  opLabel,
  onChanged,
  quiet,
}: {
  row: AttentionRowView;
  workflow: WorkflowListing;
  opLabel: (operation: string) => string;
  onChanged: () => Promise<boolean>;
  quiet: boolean;
}) {
  const ports = useMemo(
    () => ({
      settle: async () => null,
      onRecipeChanged: onChanged,
      onTablesChanged: onChanged,
      onRunSeen: () => undefined,
    }),
    [onChanged],
  );
  const runner = useWorkflowRun(row.id, ports, undefined, quiet);
  const { confirm, refusal, confirming, askRun, confirmRun, closeConfirm, dismissRefusal } =
    useRunConfirm({ runner, onPlanChanged: onChanged });

  const rows: PlanRow[] = useMemo(() => {
    if (!confirm) return [];
    const steps = new Map(workflow.steps.map((s) => [s.id, s]));
    return confirm.plan.members.map((id) => {
      const step = steps.get(id);
      return {
        id,
        label: step ? opLabel(step.operation) : id,
        dataset: step ? outputNameOf(step) : "",
        current: step?.conditions.includes("current") ?? false,
      };
    });
  }, [confirm, workflow, opLabel]);

  return (
    <>
      <div className={styles.callout} data-attention={row.id}>
        <WarnIcon />
        <span>
          <b>{row.name}</b>
          {row.owner && <OwnerPill owner={row.owner} placement="inline" />} has {row.count}{" "}
          {nodeWord(row.count)} to run again
          {row.cause ? `: ${row.cause}` : ""}.
        </span>
        {row.withheld ? (
          <AsyncState
            state={row.withheld}
            onRetry={row.withheld.status === "failed" ? row.withheld.retry : undefined}
            pendingLabel="Reading your projects…"
          >
            {() => null}
          </AsyncState>
        ) : (
          <Button
            variant="secondary"
            onClick={() => void askRun(null)}
            aria-label={`Run ${row.name}`}
          >
            <PlayIcon /> Run
          </Button>
        )}
      </div>
      {refusal && (
        <ErrorNote
          message={refusal.message}
          onRetry={refusal.retry ?? undefined}
          onDismiss={dismissRefusal}
        />
      )}
      {confirm && (
        <RunConfirmDialog
          plan={confirm.plan}
          from={null}
          rows={rows}
          notice={confirm.notice}
          busy={confirming}
          onConfirm={() => void confirmRun()}
          onClose={() => {
            if (!confirming) closeConfirm();
          }}
        />
      )}
    </>
  );
}

export function AttentionArea({
  rows,
  workflows,
  opLabel,
  onChanged,
  quiet = false,
}: {
  rows: AttentionRowView[];
  workflows: WorkflowListing[];
  opLabel: (operation: string) => string;
  onChanged: () => Promise<boolean>;
  /** The rows' runners read no runs: Run alone is offered. */
  quiet?: boolean;
}) {
  if (rows.length === 0) return null;
  const byId = new Map(workflows.map((w) => [w.id, w]));
  return (
    <div className={styles.attention}>
      {rows.map((row) => {
        const workflow = byId.get(row.id);
        if (!workflow) return null;
        return (
          <AttentionRun
            key={row.id}
            row={row}
            workflow={workflow}
            opLabel={opLabel}
            onChanged={onChanged}
            quiet={quiet}
          />
        );
      })}
    </div>
  );
}
