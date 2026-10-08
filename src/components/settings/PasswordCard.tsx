"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PasswordField } from "./PasswordField";
import { accountRequest, failureMessage } from "./api";
import { useGuardEntry } from "./settings-guard";
import { cardFormClass, CardActions, Note, SavedMark } from "./SettingsCard";
import styles from "./SettingsCard.module.css";

/** Change password: an explicit action, so its button always shows. What
 * is typed in it holds the page until it is changed or cleared. Opened by
 * the page when an address names it. The new password's rule names the
 * instance's shortest password from the runtime read; without that read it
 * names none, and the server's refusal still does. */
export function PasswordCard() {
  const [current, setCurrent] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortest, setShortest] = useState<number | undefined>(undefined);
  useGuardEntry("password", !!(current || password), "Account");
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ passwordMin?: unknown }>("/api/config").then(config => {
      if (!cancelled && typeof config.passwordMin === "number") setShortest(config.passwordMin);
    }).catch(() => { /* the refusal names the number */ });
    return () => { cancelled = true; };
  }, []);
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
      <PasswordField label="New password" value={password} onChange={value => { setPassword(value); setSaved(false); }} disabled={busy} newPassword shortest={shortest} />
      <Note>Your other browser sessions will end. API tokens stay valid.</Note>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <CardActions>
        <Button type="submit" variant="primary" busy={busy} disabled={!current || !password}>Change password</Button>
        {saved && <SavedMark text="Password changed" />}
      </CardActions>
    </form>
  </details>;
}
