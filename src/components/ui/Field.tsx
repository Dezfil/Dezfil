"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { CheckIcon } from "./icons";
import type { ControlSize } from "./Button";
import styles from "./Field.module.css";

/** The shared field look and the one focus treatment, for a surface
 * whose geometry is its own — a composer's textarea, a 24px inline field —
 * and which therefore composes the class rather than taking a component.
 * Adopting the class is adopting the contract; re-deriving the border,
 * radius and focus locally is what this ends. */
export const fieldClass = styles.field;

function withField(className?: string) {
  return className ? `${styles.field} ${className}` : styles.field;
}

/** `tier`, not `size`: the native size attribute means something else on
 * an input and a select. */
type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  ref?: Ref<HTMLInputElement>;
  tier?: ControlSize;
};

export function TextInput({ tier = "compact", className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      type={rest.type ?? "text"}
      data-size={tier}
      className={withField(className)}
    />
  );
}

export function NumberInput({
  tier = "compact",
  className,
  ...rest
}: InputProps) {
  return (
    <input
      {...rest}
      type="number"
      inputMode="decimal"
      data-size={tier}
      className={withField(className)}
    />
  );
}

export function Select({
  tier = "compact",
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: Ref<HTMLSelectElement>;
  tier?: ControlSize;
}) {
  return (
    <select {...rest} data-size={tier} className={withField(className)}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return <textarea {...rest} className={withField(className)} />;
}

/** One checkbox for the whole application. The label is associated
 * by wrapping, so the text is part of the control's target and its
 * accessible name. */
export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  ref?: Ref<HTMLInputElement>;
  /** Omit only where an ancestor already labels the control. */
  label?: ReactNode;
}) {
  return (
    <label
      className={className ? `${styles.check} ${className}` : styles.check}
      data-disabled={rest.disabled || undefined}
    >
      <span className={styles.checkWrap}>
        <input {...rest} type="checkbox" className={styles.checkInput} />
        <span className={styles.checkBox} aria-hidden>
          <CheckIcon />
        </span>
      </span>
      {label}
    </label>
  );
}
