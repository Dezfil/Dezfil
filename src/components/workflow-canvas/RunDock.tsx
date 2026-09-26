"use client";

import { Button } from "../ui/Button";
import { PlayIcon, XIcon } from "../ui/icons";
import { outcomeLine, settledCount } from "./run-overlay";
import type { WorkflowRunner } from "./use-workflow-run";
import styles from "./WorkflowCanvas.module.css";

/**
 * The frame's run chrome: the primary action that is *Run all* until a
 * run is in flight and *Cancel* while one is, at the header's far right
 * on the reference's chrome treatment; the dock's words stand before it,
 * between it and the theme toggle, saying running · N of M nodes,
 * Cancelling…, then the outcome line that stays until the next run; a
 * read that could not be made offers Retry there; a refusal at the
 * action says the API's reason with Retry where a retry can succeed.
 * Never the save whisper.
 */
export function RunDock({
  runner,
  refusal,
  onRunAll,
  onDismissRefusal,
}: {
  runner: WorkflowRunner;
  /** A start the API refused, shown at the action. */
  refusal: { message: string; retry: (() => void) | null } | null;
  onRunAll: () => void;
  onDismissRefusal: () => void;
}) {
  const { active, phase, ended, readFailure } = runner.state;
  const inFlight = active !== null && active.outcome === null;
  const busy = phase === "starting" || phase === "cancelling";
  return (
    <span className={styles.runChrome} data-run-chrome data-phase={phase}>
      {readFailure ? (
        <span className={styles.runDock} data-tone="bad" role="status" data-run-dock="unreachable">
          {readFailure.message}
          <button type="button" className={styles.dockAction} onClick={readFailure.retry}>
            Retry
          </button>
        </span>
      ) : phase === "cancelling" ? (
        <span className={styles.runDock} role="status" data-run-dock="cancelling">
          Cancelling…
        </span>
      ) : inFlight && active ? (
        <span className={styles.runDock} role="status" data-run-dock="running">
          <span className={styles.spin} aria-hidden="true" />
          running · <b>{settledCount(active)} of {active.members.length}</b> node{active.members.length === 1 ? "" : "s"}
        </span>
      ) : phase === "settling" && active ? (
        <span className={styles.runDock} role="status" data-run-dock="settling">
          {outcomeLine(active)}
        </span>
      ) : ended ? (
        <span className={styles.runDock} role="status" data-run-dock="ended" data-outcome={ended.outcome ?? undefined}>
          {outcomeLine(ended)}
        </span>
      ) : null}
      {refusal ? (
        <span className={styles.runDock} data-tone="bad" role="alert" data-run-refusal>
          {refusal.message}
          {refusal.retry ? (
            <button type="button" className={styles.dockAction} onClick={refusal.retry}>
              Retry
            </button>
          ) : null}
          <button type="button" className={styles.dockAction} onClick={onDismissRefusal} aria-label="Dismiss">
            <XIcon />
          </button>
        </span>
      ) : null}
      {inFlight ? (
        <Button
          variant="danger"
          size="chrome"
          className={styles.runAction}
          onClick={() => void runner.cancel()}
          busy={phase === "cancelling"}
          disabled={phase === "cancelling"}
          data-run-action="cancel"
        >
          <XIcon /> Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          size="chrome"
          className={styles.runAction}
          onClick={onRunAll}
          busy={phase === "starting"}
          disabled={busy || phase === "settling"}
          data-run-action="run-all"
        >
          <PlayIcon /> Run all
        </Button>
      )}
    </span>
  );
}
