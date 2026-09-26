"use client";

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import styles from "./IconButton.module.css";

type Props = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "aria-label" | "title" | "children"
> & {
  ref?: Ref<HTMLButtonElement>;
  /** Surfaces that key styling off a state attribute keep doing so. */
  "data-active"?: boolean | undefined;
  "data-no-dnd"?: boolean | undefined;
  /** The one human-readable action string. It becomes the accessible name
   * *and* the visible hint — a control whose tooltip a screen reader cannot
   * read is the defect this primitive exists to end. Actions whose
   * meaning changes with state pass the current one ("Hide layer"). */
  action: string;
  icon: ReactNode;
  /** Appended to the visible hint in parentheses — never to the accessible
   * name, which stays the action. A keyboard shortcut is an aid, not part
   * of what the control is called. */
  shortcut?: string;
  /** `chrome` contributes no look of its own: the builder's glass header
   * and stage buttons keep their treatment and take only the naming, the
   * hint and the hit floor from here. */
  tone?:
    | "default"
    | "accent"
    | "danger"
    | "danger-solid"
    | "accent-solid"
    | "chrome";
  /** Whether the action shows as the panel's styled hint. Defaults on, and
   * off for the chrome tone: the builder's header and stage buttons have
   * always used the browser's own tooltip, and a drawn hint there would
   * paint over the map — a new visual this package did not set out to make.
   * With the hint off the same string becomes the native title, so the
   * name and the tooltip still cannot drift. */
  hint?: boolean;
};

/** An icon-only action: one string for the name and the
 * hint, and at least a 24×24px target whatever the icon's size. */
export function IconButton({
  action,
  icon,
  shortcut,
  tone = "default",
  hint = tone !== "chrome",
  className,
  ...rest
}: Props) {
  const classes = [styles.iconBtn, hint ? styles.hint : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const tip = shortcut ? `${action} (${shortcut})` : action;
  return (
    <button
      {...rest}
      type="button"
      className={classes}
      data-tone={tone}
      aria-label={action}
      data-hint={hint ? tip : undefined}
      title={hint ? undefined : tip}
    >
      {icon}
    </button>
  );
}

export default IconButton;
