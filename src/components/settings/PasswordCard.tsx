"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PasswordField } from "./PasswordField";
import { accountRequest, failureMessage } from "./api";
import styles from "../SettingsScreen.module.css";

export function PasswordCard() {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      if (window.location.hash === "#password" && details.current) {
        details.current.open = true; details.current.scrollIntoView();
      }
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  const [current, setCurrent] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try {
      await accountRequest("/api/account/password", "POST", { currentPassword: current, password });
      setCurrent(""); setPassword(""); setSaved(true);
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <details ref={details} id="password" className={styles.passwordSection}>
    <summary>Change password</summary>
    <form className={styles.cardForm} onSubmit={submit}>
      <PasswordField label="Current password" value={current} onChange={value => { setCurrent(value); setSaved(false); }} disabled={busy} />
      <PasswordField label="New password" value={password} onChange={value => { setPassword(value); setSaved(false); }} disabled={busy} newPassword />
      <p className={styles.note}>Your other browser sessions will end. API tokens stay valid.</p>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" busy={busy} disabled={!current || !password}>Change password</Button>
        {saved && <span className={styles.savedNote} role="status">Password changed</span>}
      </div>
    </form>
  </details>;
}
