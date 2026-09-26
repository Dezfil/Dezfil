"use client";

import styles from "./SuccessFace.module.css";

/**
 * What a finished run shows: the thing that was made — the layer where one
 * was created, otherwise the dataset — the honest sentence with its
 * warnings, and the two ways onward. Long names wrap; nothing here clips
 * mid-word.
 */
export interface RunSuccess {
  /** The served label of the tool that ran — the face header's title. */
  tool: string;
  /** The registered output table. */
  table: string;
  /** The completed table's row count, when it was read. */
  rows: number | null;
  /** Its geometry class; null with `spatial` true is an empty spatial
   * result — undetermined, not table-only. */
  geometryType: string | null;
  spatial: boolean;
  /** The created layer's display name, or null for a table-only result and
   * a refused layer alike — the notice says which. */
  layerName: string | null;
  /** The full sentence, warnings included, as the authoring path wrote it. */
  notice: string;
}

export function SuccessFace({
  made,
  onRunAnother,
  onDone,
}: {
  made: RunSuccess;
  /** Starts a fresh action — a new invisible recipe, never a second step on
   * this one. */
  onRunAnother: () => void;
  onDone: () => void;
}) {
  return (
    <div className={styles.face} data-success-face>
      <p className={styles.headline}>
        <strong>{made.layerName ?? made.table}</strong>
      </p>
      <p className={styles.table} data-success-facts>
        {made.layerName !== null ? (
          <>
            reading <code>{made.table}</code>
          </>
        ) : (
          <code>{made.table}</code>
        )}
        {made.rows !== null && <> · {made.rows.toLocaleString()} rows</>}
        {" · "}
        {made.geometryType
          ? made.geometryType.toLowerCase()
          : made.spatial
            ? "spatial: no geometries to classify"
            : "table only"}
      </p>
      <p className={styles.notice} data-run-notice role="status">
        {made.notice}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.again}
          data-run-another
          onClick={onRunAnother}
        >
          Run another tool
        </button>
        <button
          type="button"
          className={styles.done}
          data-success-done
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  );
}
