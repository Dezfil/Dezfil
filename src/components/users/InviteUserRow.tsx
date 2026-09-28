"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox, TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { failureMessage } from "@/components/settings/api";
import type { HandOver } from "./SignInHandOver";
import styles from "./UsersScreen.module.css";

export function InviteUserRow({ onCreated, onCancel, onReactivate }: {
  onCreated: (value: HandOver) => void; onCancel: () => void; onReactivate: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [reactivateId, setReactivateId] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setReactivateId(null);
    try {
      const response = await fetch("/api/users", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, isAdmin: admin }), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        if (body.error?.canReactivate === true && typeof body.error.accountId === "string") setReactivateId(body.error.accountId);
        throw new Error(body.error?.message ?? "The invitation could not be created.");
      }
      onCreated(body as HandOver);
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  async function reactivate() {
    setBusy(true);
    try { await onReactivate(reactivateId!); }
    catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <div className={styles.invitation}>
    <form className={styles.newRow} onSubmit={submit} aria-label="Invite user">
      <TextInput aria-label="Name" placeholder="Name" autoComplete="off" value={name} maxLength={80} required disabled={busy} onChange={event => setName(event.target.value)} autoFocus />
      <TextInput aria-label="Email" type="email" placeholder="Email" autoComplete="off" value={email} required disabled={busy}
        onChange={event => { setEmail(event.target.value); setReactivateId(null); setError(null); }} />
      <Checkbox label="Admin" checked={admin} disabled={busy} onChange={event => setAdmin(event.target.checked)} />
      <div className={styles.newActions}><Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy} disabled={!name.trim() || !email.trim()}>Create account</Button></div>
    </form>
    {error && <div className={styles.invitationError}><ErrorNote message={error} onDismiss={() => { setError(null); setReactivateId(null); }} />
      {reactivateId && <Button busy={busy} onClick={() => void reactivate()}>Reactivate existing account</Button>}
    </div>}
  </div>;
}
