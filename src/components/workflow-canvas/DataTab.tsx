"use client";

import type { TableInspection } from "../api";
import { formatCount } from "../api";
import { ErrorNote } from "../ui/ErrorNote";
import { ResultTable } from "../sql/ResultTable";
import type { ReadState } from "./use-dataset-reads";
import styles from "./ResultsBand.module.css";

export const NO_ROWS = "This dataset has no rows.";

/**
 * The Data tab: the dataset's first rows in the console's grid, the
 * inspection's rows and columns with the geometry column marked, a footer
 * only when the rows are cut, the band's own zero-row sentence; a read in
 * flight says so, a failed one offers Retry.
 */
export function DataTab({ inspection, retry }: { inspection: ReadState<TableInspection>; retry: () => void }) {
  if (inspection.status === "reading") {
    return (
      <div className={styles.empty} data-band-reading>
        <div>Reading the dataset…</div>
      </div>
    );
  }
  if (inspection.status === "failed") {
    return (
      <div className={styles.errorWrap} data-band-read-failed>
        <ErrorNote message={inspection.message} onRetry={retry} retryLabel="Retry" />
      </div>
    );
  }
  if (inspection.status === "gone") return null;
  const t = inspection.value;
  const cut = t.rowCount > t.preview.length;
  return (
    <div className={styles.tabBody} data-band-data>
      <ResultTable
        columns={t.columns}
        rows={t.preview}
        geometryColumn={t.geometryColumn}
        footer={cut ? `Showing the first ${formatCount(t.preview.length)} of ${formatCount(t.rowCount)} rows.` : null}
        emptyText={NO_ROWS}
      />
    </div>
  );
}
