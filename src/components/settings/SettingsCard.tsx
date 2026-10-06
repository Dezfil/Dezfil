"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./SettingsCard.module.css";

/**
 * The pieces every Settings card is drawn from: the card with its head,
 * the label-above field, the quiet Saved by a field, the red line under
 * one, the quiet note, and the Save line that shows only while typed text
 * waits.
 */

export function SettingsCard({ id, title, headingId, head, children }: {
  id?: string;
  title: string;
  headingId: string;
  /** Quiet actions at the head's right. */
  head?: ReactNode;
  children: ReactNode;
}) {
  return <section id={id} className={styles.card} aria-labelledby={headingId}>
    <div className={styles.head}>
      <h2 id={headingId} tabIndex={-1}>{title}</h2>
      {head}
    </div>
    {children}
  </section>;
}

/** A column of a card's parts. */
export function CardStack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>;
}

/** The label above its field, the Saved mark beside the label (outside it,
 * so the field's name never changes), the red line and a rule under it. */
export function LabelledField({ id, label, inputId, saved, error, errorId, rule, ruleId, children }: {
  id?: string;
  label: ReactNode;
  inputId: string;
  saved?: boolean;
  error?: string | null;
  errorId?: string;
  rule?: ReactNode;
  ruleId?: string;
  children: ReactNode;
}) {
  return <div className={styles.field} id={id}>
    <div className={styles.fieldHead}>
      <label htmlFor={inputId}>{label}</label>
      {saved && <SavedMark />}
    </div>
    {children}
    {error && <p id={errorId} className={styles.fieldError}>{error}</p>}
    {rule && <p id={ruleId} className={styles.note}>{rule}</p>}
  </div>;
}

export function SavedMark({ text = "Saved" }: { text?: string }) {
  return <span className={styles.saved} role="status">{text}</span>;
}

export function Note({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} className={styles.note}>{children}</p>;
}

/** A row of a card's buttons. */
export function CardActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

/** Save and Cancel, drawn only while the card's typed text differs from
 * what was saved. Save submits the card's form. */
export function SaveLine({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return <div className={styles.saveLine}>
    <Button type="submit" variant="primary" busy={busy}>Save</Button>
    <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
  </div>;
}

/** The class a card's form takes: its parts in a column. */
export const cardFormClass = styles.stack;
