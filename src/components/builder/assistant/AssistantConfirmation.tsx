import React from "react";
import type { PendingReceipt } from "@/lib/assistant/runs";
import styles from "../AssistantPanel.module.css";

/** The confirmation card: the
 * API's resolved target and consequence for the gate and two buttons. No
 * operation identifier is on the card; it lives in the record's
 * inspection. The sentence about sending another message left with spec
 * ruling: while a card waits the input is disabled and Stop, in the Send
 * slot, is the way out, its own label the affordance. */
export function AssistantConfirmation({ pending, promptId, busy, resolve }: {
  pending: PendingReceipt | null; promptId: string; busy: boolean; resolve: (approved: boolean) => void;
}) {
  const target = pending?.confirmation?.target ?? "Confirm this action?";
  const consequence = pending?.confirmation?.consequence ?? "The action details could not be read. Cancel and try a new message.";
  // The gate's words reach the status region through the pane's one
  // announcer (TurnAnnouncements.tsx), never twice.
  return <>
    {pending && <div className={styles.confirm} role="group" aria-labelledby={promptId} data-confirmation>
      <p id={promptId}><strong>{target}</strong></p>
      <p>{consequence}</p>
      <div className={styles.confirmActions}>
        <button disabled={busy || !pending.confirmation} className={styles.approve} onClick={() => resolve(true)}>Confirm</button>
        <button disabled={busy} className={styles.deny} onClick={() => resolve(false)}>Cancel</button>
      </div>
    </div>}
  </>;
}
