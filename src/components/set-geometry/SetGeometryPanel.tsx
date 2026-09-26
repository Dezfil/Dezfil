"use client";

import { AsyncState } from "../ui/AsyncState";
import { CheckIcon } from "../ui/icons";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { applyEnabled, type PanelController, type PanelState } from "./panel-controller";
import { SetGeometryControls } from "./SetGeometryControls";
import styles from "./SetGeometryPanel.module.css";

/** The footer's drawn sentence: true on a first apply, false on a change. */
export const KEEP_SENTENCE = "Adds a geometry column. The original columns stay.";

/**
 * The set-geometry panel docked on the dataset page (03 shape P): the
 * header naming the dataset, the controls, the refusal as the API words
 * it, and the footer with Cancel and Apply. The page's own tabs are its
 * live preview; nothing is drawn twice.
 */
export function SetGeometryPanel({ name, state, controller }: { name: string; state: PanelState; controller: PanelController }) {
  if (state.phase === "closed") return null;
  const checking = state.preview.status === "pending" || state.rereading;
  const progress = state.applying ? "Writing geometry for all rows…"
    : state.phase === "opening" ? "Reading geometry choices…"
    : checking ? "Checking the rows…" : null;
  return (
    <aside className={styles.dock} aria-label="Set geometry" data-set-geometry-panel="">
      <header className={styles.head}>
        <strong>Set geometry</strong>
        <small>{name}</small>
      </header>
      <SetGeometryControls state={state} controller={controller} />
      {progress && <div className={styles.refusal}>
        <AsyncState state={{ status: "pending" }} pendingLabel={progress}>{() => null}</AsyncState>
      </div>}
      {(state.refusal ?? state.preview.message) && (
        <div className={styles.refusal}>
          <ErrorNote message={state.refusal ?? state.preview.message} onDismiss={state.refusal ? () => controller.dismiss() : undefined} />
        </div>
      )}
      <footer className={styles.foot}>
        {state.phase === "open" && state.mode === "first" && <span className={styles.keep}>{KEEP_SENTENCE}</span>}
        <Button variant="secondary" disabled={state.applying} onClick={() => controller.cancel()}>Cancel</Button>
        <Button variant="primary" busy={state.applying} disabled={!applyEnabled(state)} onClick={() => void controller.apply()}>
          <CheckIcon />
          {state.applying ? "Applying…" : state.phase === "opening" ? "Apply: loading…" : checking ? "Apply: checking…" : "Apply"}
        </Button>
      </footer>
    </aside>
  );
}
