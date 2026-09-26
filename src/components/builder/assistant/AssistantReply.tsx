"use client";

import { ProposalBlock, type InsertOutcome } from "./ProposalBlock";
import { isSqlBlock, segmentReply } from "./proposals";
import { ReplyProse } from "./reply-markdown";
import styles from "../AssistantPanel.module.css";

/**
 * A reply's text as the pane shows it: the prose rendered from its
 * markdown subset, code blocks, and, for a completed SQL-marked block of
 * a turn whose request carried the /sql context, the proposal with its
 * action where the host can insert. While the reply streams, the caret
 * sits at the end of the last prose block; an open fence shows the code
 * it has and carries no action.
 */
export function AssistantReply({ text, insertable, inserted, onInsert, streaming = false }: {
  text: string;
  /** The turn's request carried the /sql context (D8) and the host owns an editor. */
  insertable: boolean;
  /** How each proposal, by its block's index, has been inserted. */
  inserted?: Record<number, InsertOutcome>;
  onInsert?: (index: number, sql: string) => void;
  /** Text is still arriving: the caret marks the active segment. */
  streaming?: boolean;
}) {
  const segments = segmentReply(text);
  return (
    <div className={styles.reply} data-turn-answer data-streaming={streaming || undefined}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        if (segment.kind === "text") return <ReplyProse key={index} text={segment.text} caret={streaming && last} />;
        if (insertable && isSqlBlock(segment) && segment.complete && onInsert) {
          return <ProposalBlock key={index} sql={segment.code} outcome={inserted?.[index]} onInsert={() => onInsert(index, segment.code)} />;
        }
        return <pre key={index} className={styles.code} data-lang={segment.lang ?? undefined}>{segment.code}</pre>;
      })}
    </div>
  );
}
