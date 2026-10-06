import type { ReactNode } from "react";
import { TextInput } from "@/components/ui/Field";
import { LockIcon } from "@/components/ui/icons";
import type { ServerSetState } from "./server-set";
import styles from "./SettingRows.module.css";

/** A settings row: the label (and a meta line) at the left, the control at
 * the right and named by the label. `stack` puts a wide control under it. */
export function SettingRow({ id, label, meta, after, stack, children }: {
  id: string;
  label: ReactNode;
  meta?: ReactNode;
  /** Quiet words after the control. */
  after?: ReactNode;
  stack?: boolean;
  children: ReactNode;
}) {
  const labelId = `${id}-label`;
  return <div className={styles.row} id={id} data-stack={stack || undefined}>
    <div className={styles.rowLabel}>
      <b id={labelId}>{label}</b>
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </div>
    <div className={styles.rowControl} role="group" aria-labelledby={labelId}>
      {children}
      {after && <span className={styles.after}>{after}</span>}
    </div>
  </div>;
}

/** A read-only value in full ink with even figures; `mono` for a path or
 * an identifier. */
export function ValueText({ mono, children }: { mono?: boolean; children: ReactNode }) {
  return <span className={styles.value} data-mono={mono || undefined}>{children}</span>;
}

function Sentence({ state }: { state: ServerSetState }) {
  if (state.kind === "locked") {
    return state.invalid
      ? <><code>{state.variable}</code> in the server&apos;s environment is not valid, so the default is used.</>
      : <>Set in the server&apos;s environment by <code>{state.variable}</code>.</>;
  }
  return state.variable ? <>Changes with <code>{state.variable}</code> when the server restarts.</> : null;
}

/** A value the server decides: a disabled field with a lock inside and,
 * under it, what decides it. The field shows the value in effect, so an
 * override the server could not use shows the default it fell back to. */
export function LockedField({ label, value, state, width = "l" }: {
  /** The field's accessible name: the row's label. */
  label: string;
  value: string;
  state: ServerSetState;
  width?: "s" | "m" | "l";
}) {
  const sentence = <Sentence state={state} />;
  const said = state.kind === "locked" || state.variable !== null;
  return <span className={styles.locked} data-w={width}>
    <span className={styles.lockedField}>
      <TextInput disabled readOnly value={value} aria-label={label} />
      <LockIcon />
    </span>
    {said && <span className={styles.lockedNote}>{sentence}</span>}
  </span>;
}
