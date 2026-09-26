"use client";

import { BroomIcon } from "../../ui/icons";
import { CLEAR_LABEL, CLEAR_WAIT_HINT } from "./clear-control";
import styles from "./ClearConversation.module.css";

/**
 * The control that ends the conversation: a broom in the pane's header,
 * at the close control's weight and never wider than it, standing just
 * before the close.
 *
 * It is rendered only where there is something to clear — its absence is
 * `clear-control.ts`'s decision, not this component's — and it explains
 * itself only while it is inert, which is the one thing its own name does
 * not say.
 */
export function ClearConversation({ disabled, onClear }: { disabled: boolean; onClear: () => void }) {
  return (
    <button
      type="button"
      className={styles.clear}
      data-clear-conversation
      aria-label={CLEAR_LABEL}
      title={disabled ? CLEAR_WAIT_HINT : undefined}
      disabled={disabled}
      onClick={onClear}
    >
      <BroomIcon />
    </button>
  );
}
