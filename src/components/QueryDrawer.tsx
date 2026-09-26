"use client";

import styles from "./QueryDrawer.module.css";

interface Props {
  open: boolean;
  title: string;
  /** Small note beside the title — limits, provenance. */
  meta?: React.ReactNode;
  /** Accent border — the OSM pane marks an armed custom query. */
  accent?: boolean;
  /** Right-aligned bar actions (accept / cancel / close). */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * The query drawer: one slide-up shell over the bottom quarter of a
 * pane's map, shared by the OSM (editable) and Overture (read-only)
 * disclosures. Purely presentational — open state, editor, and actions
 * belong to the host pane. Mounted only while open, so every reveal
 * starts fresh.
 */
export function QueryDrawer({
  open,
  title,
  meta,
  accent,
  actions,
  children,
}: Props) {
  if (!open) return null;
  return (
    <section
      className={styles.drawer}
      data-accent={accent || undefined}
      role="region"
      aria-label={title}
    >
      <div className={styles.bar}>
        <b>{title}</b>
        {meta !== undefined && <span className={styles.meta}>{meta}</span>}
        <span className={styles.space} />
        {actions}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
