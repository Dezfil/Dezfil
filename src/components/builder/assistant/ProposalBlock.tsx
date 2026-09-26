"use client";

import { CheckIcon, InsertIcon } from "../../ui/icons";
import styles from "../AssistantPanel.module.css";

/**
 * A SQL proposal: the block's exact text with Insert into editor under
 * it. Offered only where the host can insert, that is on /sql for a
 * proposal whose request carried the /sql context (D8); elsewhere a SQL
 * block is text with no action. Inserted, the block says the SQL is in
 * the editor; where the draft had changed since the request, the one
 * hint this pane carries names that surprise (D1).
 */
export type InsertOutcome = "replaced" | "appended";

export const APPENDED_NOTE = "Your draft changed since this was proposed, so it was added below it.";

export function ProposalBlock({ sql, outcome, onInsert }: {
  sql: string;
  /** How Insert landed, once it has. */
  outcome?: InsertOutcome;
  /** Present where the host owns an editor and the proposal is this page's. */
  onInsert?: () => void;
}) {
  const inserted = outcome !== undefined;
  return (
    <div className={styles.proposal} data-proposal data-inserted={inserted || undefined}>
      <pre className={styles.proposalSql}>{sql}</pre>
      {onInsert && (
        <div className={styles.proposalFoot}>
          {outcome === "appended" && <p className={styles.proposalNote}>{APPENDED_NOTE}</p>}
          <span className={styles.proposalSpace} />
          <button type="button" className={styles.insert} data-done={inserted || undefined} disabled={inserted} onClick={onInsert}>
            {inserted ? <CheckIcon /> : <InsertIcon />}
            {inserted ? "In the editor" : "Insert into editor"}
          </button>
        </div>
      )}
    </div>
  );
}
