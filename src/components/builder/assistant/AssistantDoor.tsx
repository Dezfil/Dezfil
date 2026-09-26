"use client";

import { SparkleIcon } from "../../ui/icons";

/**
 * The assistant's door (on three): one control in the header's left
 * action group, after Undo and Redo where the page has them and first
 * where it does not. The accessible name flips with the state and never
 * depends on the visible word, which compact widths hide; the hint arms
 * only while the word hides. The host passes the header's own button
 * treatment.
 */
export interface AssistantDoorProps {
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Aria-expanded and aria-controls, from the pane's shell. */
  triggerProps: { "aria-expanded": boolean; "aria-controls": string };
  onToggle: () => void;
}

export function AssistantDoor({ open, triggerRef, triggerProps, onToggle, className }: AssistantDoorProps & { className: string }) {
  const name = open ? "Close assistant" : "Open assistant";
  return (
    <button
      ref={triggerRef}
      type="button"
      className={className}
      aria-label={name}
      data-hint={name}
      data-assistant-door
      {...triggerProps}
      onClick={onToggle}
    >
      <SparkleIcon />
      <span>Assistant</span>
    </button>
  );
}
