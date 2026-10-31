"use client";
import { useCallback, useEffect, useState } from "react";
import { KEY_ADDRESS, KeyForm, PROVIDER_NAMES, type KeyStatus } from "@/components/builder/assistant/KeyForm";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "./api";
import { useGuardEntry } from "./settings-guard";
import { useDrawn } from "./settings-land";
import { CardActions, Note, SavedMark, SettingsCard } from "./SettingsCard";
import { Rows, SettingRow, ValueText } from "./SettingRows";
import styles from "./SettingsCard.module.css";

/** What removing a key leads to, as the question says it. */
function afterRemoval(instanceKey: boolean): string {
  return `Turns in progress stop. ${instanceKey ? "The assistant uses the instance's key for you." : "The assistant stops answering you until you add another."}`;
}

/**
 * The key's home: which key it is, Replace and Remove behind its question. The
 * form comes up in place and leaves as soon as the save lands, and the saved key
 * stays until another is saved. Which key answers when the instance has one too
 * is the one surprise worth a line.
 */
export function AssistantKeyCard() {
  const [status, setStatus] = useState<KeyStatus | null>(null), [instanceKey, setInstanceKey] = useState(false);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [formOpen, setFormOpen] = useState(false), [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false), [busy, setBusy] = useState(false), [holding, setHolding] = useState(false);
  const onHolding = useCallback((value: boolean) => setHolding(value), []);
  useGuardEntry("assistant-key", holding, "Your AI key");
  useDrawn(status !== null || error !== null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      accountRequest<KeyStatus>(KEY_ADDRESS),
      accountRequest<{ instanceKey?: boolean }>("/api/assistant").catch(() => ({ instanceKey: false })),
    ]).then(([read, assistant]) => {
      if (!cancelled) { setStatus(read); setInstanceKey(assistant.instanceKey === true); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  async function remove() {
    setBusy(true); setError(null);
    try {
      await accountRequest(KEY_ADDRESS, "DELETE");
      setStatus({ key: null, unreadable: false }); setRemoving(false); setSaved(false);
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  const key = status?.key ?? null;
  const unreadable = status?.unreadable === true;
  return <SettingsCard id="ai-key" title="Your AI key" headingId="ai-key-heading">
    {error && !removing && <ErrorNote message={error} onRetry={status === null ? () => { setError(null); setAttempt(value => value + 1); } : undefined}
      onDismiss={status === null ? undefined : () => setError(null)} />}
    {status === null && !error && <p role="status" className={styles.note}>Loading…</p>}
    {status !== null && (formOpen ? <>
      {key && !unreadable && <Note>The saved key stays until you save another.</Note>}
      <KeyForm initialProvider={key?.provider} onHolding={onHolding} onCancel={() => setFormOpen(false)}
        onSaved={next => { setStatus(next); setFormOpen(false); setSaved(true); }} />
    </> : <>
      <Rows>
        <SettingRow id="set-ai-key" label="Key" meta={key && !unreadable ? `Added ${new Date(key.savedAt).toLocaleDateString()}` : undefined}
          mark={saved ? <SavedMark /> : undefined}>
          {key && !unreadable
            ? <ValueText>{PROVIDER_NAMES[key.provider]} · ends in <span className={styles.mono}>{key.lastFour}</span></ValueText>
            : <ValueText muted>{unreadable ? "Can no longer be read" : "Not set up"}</ValueText>}
          <Button onClick={() => { setSaved(false); setFormOpen(true); }}>{key ? "Replace" : "Add key"}</Button>
          {key && <Button variant="quiet" onClick={() => { setError(null); setSaved(false); setRemoving(true); }}>Remove</Button>}
        </SettingRow>
      </Rows>
      {unreadable && <Note>Your saved API key can no longer be read. Add it again.</Note>}
      {instanceKey && <Note>{key && !unreadable ? "This instance has a key too. Your messages use yours." : "This instance's key is used until you add your own."}</Note>}
    </>)}
    {removing && <Dialog label="Remove your key" className={styles.dialog} onClose={() => { if (!busy) { setRemoving(false); setError(null); } }}>
      <h2>Remove your key?</h2><p>{afterRemoval(instanceKey)}</p>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <CardActions><Button variant="danger" busy={busy} onClick={() => void remove()}>Remove key</Button>
        <Button disabled={busy} onClick={() => { setRemoving(false); setError(null); }}>Cancel</Button></CardActions>
    </Dialog>}
  </SettingsCard>;
}
