"use client";
import { useId, useState } from "react";
import { TextInput } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { LabelledField } from "./SettingsCard";
import styles from "./SettingsCard.module.css";

export function PasswordField({ label, value, onChange, disabled, newPassword = false, unitKey, error }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; newPassword?: boolean;
  /** The save unit's key, when a unit moves focus to it. */
  unitKey?: string;
  /** The red line under it. */
  error?: string | null;
}) {
  const id = useId(), [shown, setShown] = useState(false);
  const described = [error ? `${id}-error` : null, newPassword ? `${id}-rule` : null].filter(Boolean).join(" ") || undefined;
  return <LabelledField label={label} inputId={id} error={error} errorId={`${id}-error`}
    rule={newPassword ? "At least 8 characters." : undefined} ruleId={`${id}-rule`}>
    <div className={styles.password}>
      <TextInput id={id} type={shown ? "text" : "password"} autoComplete={newPassword ? "new-password" : "current-password"}
        value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required
        data-unit-key={unitKey} aria-invalid={error ? true : undefined} aria-describedby={described} />
      <IconButton action={shown ? "Hide password" : "Show password"} aria-pressed={shown} disabled={disabled}
        icon={shown ? <EyeOffIcon /> : <EyeIcon />} onClick={() => setShown(!shown)} />
    </div>
  </LabelledField>;
}
