"use client";

import styles from "./Switch.module.css";

/**
 * The one switch (drawer switch): an immediate on/off state's control —
 * a native checkbox with the switch role, so keyboard and assistive
 * behaviour are the platform's. Checkboxes remain the word for picking
 * many from a list.
 *
 * Two label shapes serve the app's two habits: `Switch` is the bare
 * input for hosts that lay out their own label (the Tools drawer);
 * `SwitchRow` wraps a label around it (the kit checkbox's manner).
 *
 * One ruled exception to the list rule: the export
 * rail's per-widget rows are switches — that list alone.
 */

export function Switch(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "role">,
) {
  const { className, ...rest } = props;
  return (
    <input
      type="checkbox"
      role="switch"
      className={className ? `${styles.switch} ${className}` : styles.switch}
      {...rest}
    />
  );
}

export function SwitchRow({
  label,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "role"> & {
  label: React.ReactNode;
}) {
  return (
    <label className={className ? `${styles.row} ${className}` : styles.row}>
      <Switch {...rest} />
      {label}
    </label>
  );
}
