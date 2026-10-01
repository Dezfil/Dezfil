"use client";
import { useState, type FormEvent } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { DISPLAY_NAME_EVENT } from "@/components/UserBadge";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PasswordCard } from "./PasswordCard";
import { PasswordField } from "./PasswordField";
import { accountRequest, failureMessage } from "./api";
import styles from "../SettingsScreen.module.css";

export function AccountCard({ account }: { account: Account }) {
  const [savedAccount, setSavedAccount] = useState(account);
  const [name, setName] = useState(account.name), [email, setEmail] = useState(account.email);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changingEmail = email.trim().toLowerCase() !== savedAccount.email;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try {
      const { account: updated } = await accountRequest<{ account: Account }>("/api/account", "PATCH", {
        name, ...(changingEmail ? { email, currentPassword: current } : {}),
      });
      setSavedAccount(updated); setName(updated.name); setEmail(updated.email); setCurrent(""); setSaved(true);
      window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: updated.name }));
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <section id="account" aria-labelledby="account-heading" className={styles.card}>
    <h2 id="account-heading">Account</h2>
    <form className={styles.cardForm} onSubmit={submit}>
      <label className={styles.field}><span>Display name</span><TextInput value={name} maxLength={80} required autoComplete="name" disabled={busy}
        onChange={event => { setName(event.target.value); setSaved(false); }} /></label>
      <p className={styles.sqlName}><span>SQL name</span><code>{savedAccount.sqlName}</code></p>
      <label className={styles.field}><span>Email</span><TextInput type="email" value={email} required autoComplete="email" disabled={busy}
        onChange={event => { setEmail(event.target.value); setSaved(false); }} /></label>
      {changingEmail && <PasswordField label="Current password to change email" value={current} onChange={setCurrent} disabled={busy} />}
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !email.trim() || (changingEmail && !current)}>Save</Button>
        {saved && <span className={styles.savedNote} role="status">Saved</span>}
      </div>
    </form>
    <PasswordCard />
  </section>;
}
