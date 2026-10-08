"use client";
import { useRef, type ReactNode } from "react";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { NumberInput, Textarea, TextInput } from "@/components/ui/Field";
import { LockIcon } from "@/components/ui/icons";
import type { ServerSetState } from "./server-set";
import styles from "./SettingRows.module.css";

/** A change this soon after an arrow or page key is that key's step. */
const STEP_KEY_MS = 300;
const STEP_KEYS = /^(ArrowUp|ArrowDown|PageUp|PageDown)$/;

/** A card's rows, one under the other with a rule between them. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className={styles.rows}>{children}</div>;
}

/** A settings row: the label (and a meta line) at the left, the control at
 * the right and named by the label. `stack` puts a wide control under it.
 * `mark` stands beside the label, outside it, so the control's name never
 * changes: the quiet Saved of a row whose control fills its width. */
export function SettingRow({ id, label, meta, after, stack, mark, children }: {
  id: string;
  label: ReactNode;
  meta?: ReactNode;
  /** Quiet words after the control. */
  after?: ReactNode;
  stack?: boolean;
  mark?: ReactNode;
  children: ReactNode;
}) {
  const labelId = `${id}-label`;
  const name = <b id={labelId}>{label}</b>;
  return <div className={styles.row} id={id} data-stack={stack || undefined}>
    <div className={styles.rowLabel}>
      {mark === undefined ? name : <span className={styles.labelLine}>{name}{mark}</span>}
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </div>
    <div className={styles.rowControl} role="group" aria-labelledby={labelId}>
      {children}
      {after && <span className={styles.after}>{after}</span>}
    </div>
  </div>;
}

/**
 * A number a settings row keeps as it changes, with quiet words before it
 * where a row holds several and its unit after it. A step (the arrow or
 * page keys, the spin buttons, the wheel) is reported as a step; typing
 * is reported as typing and kept on Enter or on leaving the field. A
 * browser marks a typed change with its input type and a step without one.
 */
export function NumberField({ label, unitKey, value, prefix, unit, min, max, step = 1, error, errorId, onStep, onType, onCommit }: {
  /** The field's accessible name: the row's label, or its own where the
   * row holds several. */
  label: string;
  /** The save unit's key, when a unit moves focus to it. */
  unitKey: string;
  value: string;
  /** The field's own name, shown before it. */
  prefix?: string;
  unit?: string;
  min?: number;
  max?: number;
  /** How far a step moves it: a whole number by default, a finer step or
   * any amount where it takes decimals. */
  step?: number | "any";
  /** The red line under the row, when there is one. */
  error?: string | null;
  errorId: string;
  onStep: (text: string) => void;
  onType: (text: string) => void;
  onCommit: () => void;
}) {
  const steppedAt = useRef(0);
  return <span className={styles.withUnit}>
    {prefix}
    <NumberInput className={styles.number} aria-label={label} data-unit-key={unitKey} value={value} min={min} max={max} step={step}
      aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
      onKeyDown={event => {
        if (STEP_KEYS.test(event.key)) steppedAt.current = Date.now();
        if (event.key === "Enter" && !event.nativeEvent?.isComposing) { event.preventDefault(); onCommit(); }
      }}
      onChange={event => {
        const inputType = (event.nativeEvent as InputEvent | undefined)?.inputType;
        const stepped = !inputType || Date.now() - steppedAt.current < STEP_KEY_MS;
        steppedAt.current = 0;
        (stepped ? onStep : onType)(event.target.value);
      }}
      onBlur={() => onCommit()} />
    {unit}
  </span>;
}

/** A settings row's choice drawn as segments: the shipped choice group (one
 * radio group named by its row, one tab stop on the chosen segment, the
 * arrows moving the choice) in the settings surface's own look. A choice
 * too long for its row wraps into even lines. */
export function SegmentChoice<T extends string>({ label, value, choices, onChange }: {
  /** The row's label: the group's accessible name. */
  label: string;
  value: T;
  choices: readonly { readonly value: T; readonly label: string }[];
  onChange: (next: T) => void;
}) {
  return <ChoiceGroup label={label} value={value} onChange={onChange} choices={choices}
    className={styles.segments} itemClassName={styles.segment} />;
}

/** The red line under a row: the reason its value was not kept. */
export function RowError({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className={styles.rowError}>{children}</p>;
}

/** A read-only value in full ink with even figures; `mono` for a path or
 * an identifier, `muted` for nothing set. */
export function ValueText({ mono, muted, children }: { mono?: boolean; muted?: boolean; children: ReactNode }) {
  return <span className={styles.value} data-mono={mono || undefined} data-muted={muted || undefined}>{children}</span>;
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
 * override the server could not use shows the default it fell back to.
 * A list (hosts, one per line) shows its lines; an address or a host is
 * `mono`. */
export function LockedField({ label, value, lines, mono, state, width = "l" }: {
  /** The field's accessible name: the row's label. */
  label: string;
  value: string;
  /** A list's lines, drawn one per line in place of `value` while there are any. */
  lines?: readonly string[];
  mono?: boolean;
  state: ServerSetState;
  width?: "s" | "m" | "l";
}) {
  const sentence = <Sentence state={state} />;
  const said = state.kind === "locked" || state.variable !== null;
  return <span className={styles.locked} data-w={width}>
    <span className={styles.lockedField}>
      {lines?.length
        ? <Textarea disabled readOnly value={lines.join("\n")} rows={lines.length} aria-label={label} data-mono={mono || undefined} />
        : <TextInput disabled readOnly value={value} aria-label={label} data-mono={mono || undefined} />}
      <LockIcon />
    </span>
    {said && <span className={styles.lockedNote}>{sentence}</span>}
  </span>;
}
