"use client";

import { chipFor, type WorkflowListing } from "./workflow-model";
import gallery from "./gallery.module.css";
import styles from "./WorkflowStatusChip.module.css";

/**
 * The one chip a workflow wears for its state, worded from the API's
 * summary: the Workflows list's, and the Data page's folders', so both
 * pages say the same words in the same tones.
 */
export function WorkflowStatusChip({ summary }: { summary: WorkflowListing["summary"] }) {
  const chip = chipFor(summary);
  return (
    <span className={`${gallery.chip} ${styles.stateChip}`} data-tone={chip.tone} data-workflow-state>
      <i />
      {chip.label}
    </span>
  );
}
