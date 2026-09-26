"use client";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { PlayIcon } from "../ui/icons";
import type { CanvasGraph } from "./graph";
import type { RunPlan } from "./use-workflow-run";
import styles from "./WorkflowCanvas.module.css";

/**
 * The wide-run confirmation: one dialog naming the run, listing the nodes
 * in the order the API plans with the dataset each writes, saying which
 * are current and will run again, and offering Run N nodes or Cancel.
 * Confirming starts exactly these, in this order. The rows arrive derived,
 * so a host without the canvas graph (the project home) shares the same
 * dialog.
 */

export interface PlanRow {
  id: string;
  label: string;
  dataset: string;
  current: boolean;
}

/** The canvas host's row derivation, exactly as the dialog owned it. */
export function rowsFromGraph(memberIds: string[], graph: CanvasGraph): PlanRow[] {
  return memberIds.map((id) => {
    const m = graph.members.find((x) => x.id === id);
    const label = m?.kind === "node" ? m.label : id;
    const dataset = m?.kind === "node" ? m.outputName : "";
    const current = m?.kind === "node" && m.step.conditions.includes("current");
    return { id, label, dataset, current };
  });
}

export function RunConfirmDialog({
  plan,
  from,
  rows,
  notice,
  busy,
  onConfirm,
  onClose,
}: {
  plan: RunPlan;
  /** The node a *Run from here* starts at; null for Run all. */
  from: string | null;
  rows: PlanRow[];
  /** A refusal to show above the plan: the workflow changed since. */
  notice: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const again = rows.filter((r) => r.current);
  const n = rows.length;
  const title = from ? `Run from ${from}` : "Run all";
  return (
    <Dialog label={title} onClose={onClose} className={styles.confirm} data-run-confirm data-plan-kind={plan.kind}>
      <div className={styles.confirmHead}>
        <strong>{title}</strong>
        <small>
          {n} node{n === 1 ? "" : "s"} run in this order.
          {again.length ? ` ${again.map((r) => r.label).join(", ")} ${again.length === 1 ? "is" : "are"} current and ${again.length === 1 ? "runs" : "run"} again.` : ""}
        </small>
      </div>
      {notice ? (
        <p className={styles.problem} role="alert" data-plan-notice>
          {notice}
        </p>
      ) : null}
      <ol className={styles.planList} data-plan-list>
        {rows.map((r) => (
          <li key={r.id} data-current={r.current || undefined}>
            <b>{r.label}</b>
            <span className={styles.planArrow} aria-hidden="true">
              →
            </span>
            <code>{r.dataset || "unnamed"}</code>
          </li>
        ))}
      </ol>
      <div className={styles.confirmFoot}>
        <Button variant="quiet" onClick={onClose} disabled={busy} data-cancel-run>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} busy={busy} data-confirm-run>
          <PlayIcon /> Run {n} node{n === 1 ? "" : "s"}
        </Button>
      </div>
    </Dialog>
  );
}
