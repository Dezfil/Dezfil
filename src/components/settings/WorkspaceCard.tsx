"use client";
import { useState, type FormEvent } from "react";
import { INSTANCE_NAME_EVENT } from "@/components/shell/path-model";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "./api";
import styles from "../SettingsScreen.module.css";

export function WorkspaceCard({ name, admin }: { name: string | null; admin: boolean }) {
  const [instance, setInstance] = useState(name ?? "");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try {
      const body = await accountRequest<{ instanceName: string | null }>("/api/settings", "PATCH", { instanceName: instance });
      setInstance(body.instanceName ?? ""); setSaved(true);
      window.dispatchEvent(new CustomEvent(INSTANCE_NAME_EVENT, { detail: body.instanceName }));
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className={styles.card} aria-labelledby="instance-heading">
    <h2 id="instance-heading">Instance</h2>
    <form className={styles.cardForm} onSubmit={submit}>
      <label className={styles.field}><span>Instance name</span><TextInput value={instance} disabled={!admin || busy} maxLength={80}
        onChange={event => { setInstance(event.target.value); setSaved(false); }} /></label>
      {!admin && <p className={styles.note}>Only admins can change the instance name.</p>}
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      {admin && <div className={styles.actions}>
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
        {saved && <span className={styles.savedNote} role="status">Saved</span>}
      </div>}
    </form>
  </section>;
}
