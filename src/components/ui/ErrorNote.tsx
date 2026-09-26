"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { CaretIcon, XIcon } from "./icons";
import styles from "./ErrorNote.module.css";

/** How the application says something went wrong.
 *
 * The voice rule (R10): a plain sentence in the UI face saying what
 * happened and what to do, a dismissal or a retry, and engine detail
 * behind a disclosure.
 *
 * `detail` is for text that came from the engine, and it is not a general
 * licence: closure keeps unexpected failures sanitized everywhere, and
 * only the builder's documented errored-render carve-out puts a raw
 * diagnostic in front of an author. Pass `detail` where that carve-out
 * supplies it; pass a written sentence everywhere else. */
export function ErrorNote({
  message,
  detail,
  detailLabel = "Technical detail",
  tone = "danger",
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  announce = true,
  className,
  children,
  ...rest
}: {
  message: ReactNode;
  detail?: string | null;
  detailLabel?: string;
  tone?: "danger" | "warn";
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  /** Set false only when this note mirrors a failure whose primary,
   * announcing note renders elsewhere (the builder rail's lane banner) —
   * the mirrored face must not announce the same failure twice. */
  announce?: boolean;
  className?: string;
  children?: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <div
      {...rest}
      className={className ? `${styles.note} ${className}` : styles.note}
      data-tone={tone}
      role={announce ? "alert" : undefined}
    >
      <div className={styles.body}>
        <p className={styles.message}>{message}</p>
        {detail ? (
          <details className={styles.detail}>
            <summary>
              <CaretIcon />
              {detailLabel}
            </summary>
            <div className={styles.detailText}>{detail}</div>
          </details>
        ) : null}
        {(onRetry || children) && (
          <div className={styles.actions}>
            {onRetry && (
              <Button variant="secondary" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            {children}
          </div>
        )}
      </div>
      {onDismiss && (
        <IconButton
          className={styles.dismiss}
          tone="danger"
          action="Dismiss"
          icon={<XIcon />}
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
