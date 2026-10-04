"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { TextInput } from "../ui/Field";
import { failureMessage } from "../settings/api";
import { deleteAccount, readDeletionPreview, type DeletionPreview, type DeletionStatus } from "./deletion-client";
import { DeletionTotals } from "./DeletionTotals";
import home from "../projects/ProjectHome.module.css";
import styles from "./DeleteAccountDialog.module.css";

export function DeleteAccountDialog({ account, onClose, onDone }: {
  account: DeletionPreview["account"]; onClose: () => void; onDone: (status: DeletionStatus) => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null), [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  useEffect(() => {
    let cancelled = false;
    readDeletionPreview(account.id).then(value => {
      if (cancelled) return;
      if ("state" in value) done.current(value); else setPreview(value);
    }).catch(cause => { if (!cancelled) setError(failureMessage(cause)); });
    return () => { cancelled = true; };
  }, [account.id, attempt]);
  const armed = !!preview && (preview.invited || email === preview.account.email);
  const ownsWork = preview && Object.values(preview.totals).some(count => count > 0);
  async function submit() {
    if (!armed || !preview || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { onDone(await deleteAccount(preview, email)); }
    catch (cause) {
      // A lost response may already have accepted deletion. A fresh preview
      // resolves that state without blindly resubmitting a destructive act.
      setPreview(null); setEmail(""); setError(failureMessage(cause));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog label="Delete account" className={home.dialog} onClose={() => { if (!inFlight.current) onClose(); }}>
    <div className={home.dialogHead}>
      <strong>Delete {account.name}’s account?</strong>
      {preview && <small>{preview.invited ? `${preview.account.name} never signed in, so only the invitation is removed.`
        : ownsWork ? "Everything the account owns is deleted with it. Shared work and published links become unavailable."
          : "The account owns nothing, so only the account itself goes. This cannot be undone."}</small>}
    </div>
    <div className={styles.body}>
      {!preview && !error && <p role="status">Loading deletion preview…</p>}
      {preview && !preview.invited && <>
        {ownsWork && <><DeletionTotals totals={preview.totals} />
          <p><b>{preview.people} other {preview.people === 1 ? "person loses" : "people lose"} access</b> to shared work. This cannot be undone.</p>
          <p>To keep this person&apos;s work for the team, leave the account deactivated.</p></>}
        <label className={styles.field}><span>Type <b>{preview.account.email}</b> to confirm</span>
          <TextInput aria-label="The account's email" autoComplete="off" spellCheck={false} value={email}
            disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
      </>}
      {error && <ErrorNote message={error} retryLabel="Review again" onRetry={() => {
        setPreview(null); setEmail(""); setError(null); setAttempt(value => value + 1);
      }} />}
    </div>
    <div className={home.dialogFoot}>
      <Button variant="quiet" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={!armed} busy={busy} onClick={() => void submit()}>Delete account</Button>
    </div>
  </Dialog>;
}
