"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PasswordField } from "./PasswordField";
import { accountRequest, failureMessage } from "./api";
import { useGuardEntry } from "./settings-guard";
import { cardFormClass, CardActions, Note, SavedMark } from "./SettingsCard";
import styles from "./SettingsCard.module.css";

/** Change password: an explicit action, so its button always shows. What
 * is typed in it holds the page until it is changed or cleared. Opened by
 * the page when an address names it. */
export function PasswordCard() {
  const [current, setCurrent] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useGuardEntry("password", !!(current || password), "Account");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try {
      await accountRequest("/api/account/password", "POST", { currentPassword: current, password });
      setCurrent(""); setPassword(""); setSaved(true);
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <details id="password" className={styles.details}>
    <summary>Change password</summary>
    <form className={cardFormClass} onSubmit={submit}>
      <PasswordField label="Current password" value={current} onChange={value => { setCurrent(value); setSaved(false); }} disabled={busy} />
      <PasswordField label="New password" value={password} onChange={value => { setPassword(value); setSaved(false); }} disabled={busy} newPassword />
      <Note>Your other browser sessions will end. API tokens stay valid.</Note>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <CardActions>
        <Button type="submit" variant="primary" busy={busy} disabled={!current || !password}>Change password</Button>
        {saved && <SavedMark text="Password changed" />}
      </CardActions>
    </form>
  </details>;
}
