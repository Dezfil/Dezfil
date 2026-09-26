"use client";

import type { ButtonHTMLAttributes, Ref } from "react";
import { Spinner } from "../Spinner";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ControlSize = "chrome" | "compact";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  /** A popover's trigger hands its element to the dismissal contract. */
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ControlSize;
  /** In flight: the button cannot fire again, says so to assistive tech,
   * and shows a spinner beside its label — state that does not depend on
   * colour alone. */
  busy?: boolean;
  /** Submit buttons are opt-in; everything else defaults to a plain button
   * so a stray one never submits a surrounding form. */
  type?: "button" | "submit" | "reset";
};

/** The application's button. Flat accent is the only
 * primary treatment — the gradient is retired. */
export function Button({
  variant = "secondary",
  size = "compact",
  busy = false,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      type={type}
      className={className ? `${styles.btn} ${className}` : styles.btn}
      data-variant={variant}
      data-size={size}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
    >
      {busy && <Spinner size={12} tone={variant === "primary" ? "current" : "accent"} />}
      {children}
    </button>
  );
}

export default Button;
