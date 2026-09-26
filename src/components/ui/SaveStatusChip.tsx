"use client";

import type { ReactNode } from "react";
import styles from "./SaveStatusChip.module.css";

/**
 * How long a line's text outlives the message that put it there, for a
 * channel that asks for it. It must cover the chip's own CSS exit — the
 * 300 ms hold and the 130 ms fade — because a fade cannot fade text that
 * has already left the DOM. Exported so the two cannot drift apart
 * silently.
 */
export const SAVE_STATUS_EXIT_MS = 450;

/** One transient status message, as its producer already words it: the
 * text, the danger tone the workflow's failures wear, and the one action
 * a workflow layout or recipe failure carries. */
export interface SaveStatusMessage {
  text: string;
  tone?: "bad";
  action?: { label: string; run: () => void };
}

/** A channel the chip draws a line for. `key` names the line for the
 * journeys that read it; `announce` is per channel, because the shipped
 * channels differ — the builder's notice and the workflow's whisper
 * announce politely, the builder's saving indication has no live region
 * and gains none here.
 *
 * `on` is the live signal, for the same reason: the builder's saving
 * indication kept a permanently mounted literal and so had a readable
 * exit, while the workflow's whisper cleared its text the instant its
 * owner did. A channel that passes `on` renders its message while the
 * chip closes on it but marks the line off at once, so the fade has
 * something to fade; a channel that does not is exactly its producer. */
export interface SaveStatusChannel {
  key: string;
  message: SaveStatusMessage | null;
  announce?: boolean;
  on?: boolean;
}

/**
 * The stage's top-left overlay corner: where the chip stands, placed by
 * its host.
 */
export function SaveStatusCorner({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={className ? `${styles.corner} ${className}` : styles.corner}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The chip itself, in the same-home variant: one pill holding a line per
 * channel. The builder hands it
 * two — its saving indication and its notice channel, which can be live
 * together — and the workflow canvas one. The pill grows and shrinks as
 * its channels come and go; nothing chooses between them, nothing
 * suppresses another, and each line keeps its own lifetime.
 *
 * Every line's node is always mounted and keeps its identity across
 * every message: an announcing line is a live region that must exist
 * before its content changes, and the workflow journeys watch one for
 * the texts that flash between assertions.
 */
export function SaveStatusChip({
  channels,
  ...rest
}: {
  channels: SaveStatusChannel[];
} & React.HTMLAttributes<HTMLDivElement>) {
  const on = channels.some((channel) => channel.on ?? channel.message !== null);
  return (
    <div
      className={styles.chip}
      data-on={on || undefined}
      data-save-status-chip
      {...rest}
    >
      {channels.map(({ key, message, announce, on: live }) => (
        <span
          key={key}
          className={styles.line}
          data-save-status={key}
          data-on={(live ?? message !== null) || undefined}
          data-tone={message?.tone}
          aria-live={announce ? "polite" : undefined}
        >
          {/* The band the grid row sizes: the collapse belongs to the
              line, the words to this. */}
          <span className={styles.lineText}>
            {message?.text}
            {message?.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={message.action.run}
              >
                {message.action.label}
              </button>
            ) : null}
          </span>
        </span>
      ))}
    </div>
  );
}
