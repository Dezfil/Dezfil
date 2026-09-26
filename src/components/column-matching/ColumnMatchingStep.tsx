"use client";

import { TablePreviewGrid } from "../TablePreviewGrid";
import { livePreview } from "../set-geometry/live-preview";
import { SetGeometryControls } from "../set-geometry/SetGeometryControls";
import { KEEP_SENTENCE } from "../set-geometry/SetGeometryPanel";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import type { MatchingStep, MatchingStepState } from "./matching-step";
import styles from "./ColumnMatchingStep.module.css";

/** The note under the controls: the files waiting behind this one. */
export function waitingNote(waiting: readonly string[]): string | null {
  if (waiting.length === 0) return null;
  const n = waiting.length;
  return `${n} more ${n === 1 ? "file waits" : "files wait"} for this step: ${waiting.join(", ")}`;
}

/**
 * The column-matching step's frame: the left column
 * with controls, asked to omit the map-bound pair hint, and the note
 * naming the files that wait; the right side with the reused grid over
 * the preview answer's own rows, the picks tagged and the unreadable
 * rows marked, under a heading naming how many rows the API sampled;
 * the footer with 03 P's first-apply sentence, Cancel and Confirm. The
 * header is the dialog's. The step draws no map.
 */
export function ColumnMatchingStep({ state, step, waiting }: {
  state: MatchingStepState;
  step: MatchingStep;
  waiting: readonly string[];
}) {
  const { panel, confirmable, busy } = state;
  const columns = panel.inspection?.columns ?? [];
  const grid = livePreview(panel, { columns, preview: [] });
  const note = waitingNote(waiting);
  const refusal = panel.openError ?? panel.refusal ?? panel.preview.message;
  return (
    <>
      <div className={styles.wrap} data-column-matching="">
        <div className={styles.col}>
          <SetGeometryControls state={panel} controller={step.controller} pairHint={false} />
          {refusal && (
            <ErrorNote message={refusal} onDismiss={panel.refusal ? () => step.controller.dismiss() : undefined} />
          )}
          {note && (
            <p className={styles.note}>
              <i aria-hidden />
              {note}
            </p>
          )}
        </div>
        <div className={styles.preview}>
          <h4>{panel.preview.answer ? `Preview of the first ${grid.rows.length} rows` : "Preview"}</h4>
          <TablePreviewGrid columns={grid.columns} rows={grid.rows} tags={grid.tags} marks={grid.marks} />
        </div>
      </div>
      <footer className={styles.foot}>
        {panel.mode === "first" && <span className={styles.keep}>{KEEP_SENTENCE}</span>}
        <Button variant="secondary" disabled={busy} onClick={() => step.cancel()}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!confirmable} onClick={() => void step.confirm()}>Confirm</Button>
      </footer>
    </>
  );
}
