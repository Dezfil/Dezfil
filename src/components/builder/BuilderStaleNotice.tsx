"use client";
import { useEffect, useState } from "react";
import { ErrorNote } from "../ui/ErrorNote";
import { Button } from "../ui/Button";
import { ACCESS_ENDED_MESSAGE, DISCARD_MESSAGE, STALE_MESSAGE } from "../document-sequence";
import { useUnsavedNavigation } from "../use-unsaved-navigation";
import type { useBuilderMutations } from "./use-builder-mutations";
import { readBuilderRecovery, type BuilderRecoveryProps } from "./BuilderRecovery";
import styles from "./BuilderStaleNotice.module.css";

export function BuilderStaleNotice({ mutations, onRecovered }: { mutations: ReturnType<typeof useBuilderMutations> } & BuilderRecoveryProps) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  useUnsavedNavigation(mutations.stale && !leaving);
  // Ended access is not recovered in place: past the confirm step the page
  // reloads. The unsaved-work guard lets go first (an effect's cleanup runs
  // before any effect starts), so the browser does not ask a second time.
  useEffect(() => { if (leaving) window.location.reload(); }, [leaving]);
  if (!mutations.stale) return null;
  const map = mutations.savedMap;
  const draft = map ? mutations.drafts.apply(map) : null;
  const sql = draft?.layers.filter(layer => mutations.drafts.hasLayer(layer.id)).map(layer => layer.sql).join("\n\n") ?? "";
  const legend = draft?.layers.filter(layer => mutations.drafts.hasLayer(layer.id) || mutations.legendLive[layer.id]).map(layer => mutations.legendLive[layer.id]?.legendTitle ?? layer.legendTitle ?? "").join("\n") ?? "";
  async function reload() {
    if (mutations.sequence.accessLost) { setBusy(true); setLeaving(true); return; }
    if (!map) return;
    setBusy(true); setError(null);
    try { const seed = await readBuilderRecovery(map.id); mutations.sequence.dispose(); onRecovered?.(seed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : STALE_MESSAGE); }
    finally { setBusy(false); }
  }
  return <ErrorNote message={mutations.sequence.accessLost ? ACCESS_ENDED_MESSAGE : STALE_MESSAGE} data-stale-recovery>
    <div className={styles.content}>
      {confirm && <><p>{DISCARD_MESSAGE}</p><div className={styles.actions}>
        {sql && <Button onClick={() => void navigator.clipboard.writeText(sql)}>Copy SQL</Button>}
        {legend && <Button onClick={() => void navigator.clipboard.writeText(legend)}>Copy legend title</Button>}
      </div></>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}><Button variant={confirm ? "primary" : "secondary"} busy={busy}
        onClick={() => confirm ? void reload() : setConfirm(true)}>Reload</Button>
        {confirm && <Button variant="quiet" disabled={busy} onClick={() => setConfirm(false)}>Not now</Button>}</div>
    </div>
  </ErrorNote>;
}
