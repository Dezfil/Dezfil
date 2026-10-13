"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * meanwhile, the read's failure note with Try again when it failed. The
 * note announces unless the host says the same failure is announced
 * elsewhere on the page, so it is heard once. */
export type WithheldRun =
  | { status: "pending" }
  | { status: "failed"; error: string; retry: () => void; announce?: boolean };

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
  hidden,
  onUnderWay,
}: {
  row: AttentionRowView;
  /** The workflow as listed; null once it is no longer listed. */
  workflow: WorkflowListing | null;
  opLabel: (operation: string) => string;
  onChanged: () => Promise<boolean>;
  quiet: boolean;
  /** The row has left the list while its run is followed: the runner
   * stays and draws nothing, unless reading the run fails. */
  hidden: boolean;
  /** Told when a run here is taken up, with the row as it then stood, and
   * when it has settled. */
  onUnderWay: ((row: AttentionRowView, underWay: boolean) => void) | null;
}) {
  const shown = useRef(row);
  useEffect(() => {
    shown.current = row;
  });
  const ports = useMemo(
    () => ({
      settle: async () => null,
      onRecipeChanged: onChanged,
      onTablesChanged: onChanged,
      // Said as the runner takes up the run, before the re-read it then
      // asks for can answer, so the area keeps this row before it leaves.
      onRunSeen: () => onUnderWay?.(shown.current, true),
    }),
    [onChanged, onUnderWay],
  );
  const runner = useWorkflowRun(row.id, ports, undefined, quiet);
  const { confirm, refusal, confirming, askRun, confirmRun, closeConfirm, dismissRefusal } =
    useRunConfirm({ runner, onPlanChanged: onChanged });
  // Settled, and read again after it: the run is no longer followed.
  const idle = runner.state.phase === "idle";
  useEffect(() => {
    if (idle) onUnderWay?.(shown.current, false);
  }, [idle, onUnderWay]);
  // A followed run that could not be read, or whose settlement's re-read
  // did not land: its failure stands in Run's place, with Try again, which
  // follows the run on.
  const failure = onUnderWay ? runner.state.readFailure : null;

  const rows: PlanRow[] = useMemo(() => {
    if (!confirm) return [];
    const steps = new Map((workflow?.steps ?? []).map((s) => [s.id, s]));
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

  if (hidden && !failure) return null;
  return (
    <>
      <div className={styles.callout} data-attention={row.id}>
        <WarnIcon />
        <span>
          <b>{row.name}</b>
          {row.owner && <OwnerPill owner={row.owner} placement="inline" />}
          {/* A row back for its run's failure no longer has nodes to run
              again: its run is under way. */}
          {hidden ? null : (
            <>
              {" "}
              has {row.count} {nodeWord(row.count)} to run again
              {row.cause ? `: ${row.cause}` : ""}.
            </>
          )}
        </span>
        {failure ? (
          <ErrorNote message={failure.message} onRetry={failure.retry} />
        ) : row.withheld?.status === "failed" ? (
          <ErrorNote
            message={row.withheld.error}
            onRetry={row.withheld.retry}
            announce={row.withheld.announce ?? true}
          />
        ) : row.withheld ? (
          <AsyncState state={row.withheld} pendingLabel="Reading your projects…">
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

/** The rows with a run under way, as their runners say, each as it stood
 * when its run was taken up. */
function useRunsUnderWay(): [
  ReadonlyMap<string, AttentionRowView>,
  (row: AttentionRowView, underWay: boolean) => void,
] {
  const [rows, setRows] = useState<ReadonlyMap<string, AttentionRowView>>(() => new Map());
  const say = useCallback((row: AttentionRowView, underWay: boolean) => {
    setRows((now) => {
      if (now.has(row.id) === underWay) return now;
      const next = new Map(now);
      if (underWay) next.set(row.id, row);
      else next.delete(row.id);
      return next;
    });
  }, []);
  return [rows, say];
}

export function AttentionArea({
  rows,
  workflows,
  opLabel,
  onChanged,
  quiet = false,
  followRuns = false,
}: {
  rows: AttentionRowView[];
  workflows: WorkflowListing[];
  opLabel: (operation: string) => string;
  onChanged: () => Promise<boolean>;
  /** The rows' runners read no runs: Run alone is offered. */
  quiet?: boolean;
  /** A run started from a row is followed until it settles even after the
   * row leaves the list (a run under way is no longer one to run again),
   * so its settlement still asks the host to read again; a failure to
   * read it brings its row back with Try again. */
  followRuns?: boolean;
}) {
  const [underWay, sayUnderWay] = useRunsUnderWay();
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const drawn = rows.filter((row) => byId.has(row.id));
  const shown = new Set(drawn.map((row) => row.id));
  // A followed run whose row has left keeps its runner, drawing nothing
  // unless reading the run fails, until the run settles.
  const followed = followRuns ? [...underWay.values()].filter((row) => !shown.has(row.id)) : [];
  if (drawn.length === 0 && followed.length === 0) return null;
  // One list, so a row that leaves while its run is followed keeps its
  // place among the area's children, and so its runner.
  const items = [
    ...drawn.map((row) => ({ row, hidden: false })),
    ...followed.map((row) => ({ row, hidden: true })),
  ];
  return (
    // With only followed runs drawing nothing, the area is empty and its
    // stylesheet gives it no room on the page.
    <div className={styles.attention} data-attention-area>
      {items.map(({ row, hidden }) => (
        <AttentionRun
          key={row.id}
          row={row}
          workflow={byId.get(row.id) ?? null}
          opLabel={opLabel}
          onChanged={onChanged}
          quiet={quiet}
          hidden={hidden}
          onUnderWay={followRuns ? sayUnderWay : null}
        />
      ))}
    </div>
  );
}
