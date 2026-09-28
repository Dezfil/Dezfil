"use client";
import { useId, useState } from "react";
import { TextInput } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import styles from "../SettingsScreen.module.css";

export function PasswordField({ label, value, onChange, disabled, newPassword = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; newPassword?: boolean;
}) {
  const id = useId(), [shown, setShown] = useState(false);
  return <div className={styles.field}><label htmlFor={id}>{label}</label>
    <div className={styles.password}>
      <TextInput id={id} type={shown ? "text" : "password"} autoComplete={newPassword ? "new-password" : "current-password"}
        value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required
        aria-describedby={newPassword ? `${id}-rule` : undefined} />
      <IconButton action={shown ? "Hide password" : "Show password"} aria-pressed={shown} disabled={disabled}
        icon={shown ? <EyeOffIcon /> : <EyeIcon />} onClick={() => setShown(!shown)} />
    </div>
    {newPassword && <p id={`${id}-rule`} className={styles.note}>At least 8 characters.</p>}
  </div>;
}
