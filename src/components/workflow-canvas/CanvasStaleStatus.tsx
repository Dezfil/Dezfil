"use client";
import { useEffect, useState } from "react";
import { SaveStatusChip } from "../ui/SaveStatusChip";
import { DISCARD_MESSAGE, STALE_MESSAGE } from "../document-sequence";
import { useUnsavedNavigation } from "../use-unsaved-navigation";
import { useCanvasRecovery } from "./WorkflowRecovery";

export function CanvasStaleStatus() {
  const recovery = useCanvasRecovery();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  useUnsavedNavigation(recovery.stale && !leaving);
  // Ended access is not recovered in place: past the confirm step the page
  // reloads. The unsaved-work guard lets go first (an effect's cleanup runs
  // before any effect starts), so the browser does not ask a second time.
  useEffect(() => { if (leaving) window.location.reload(); }, [leaving]);
  const notes = (recovery.document?.draftLayout?.notes ?? []).filter(note =>
    note.text !== recovery.document?.layout?.notes.find(saved => saved.id === note.id)?.text);
  async function reload() {
    if (recovery.document?.accessLost) { setBusy(true); setLeaving(true); return; }
    setBusy(true); setError(null);
    try { await recovery.recover?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : STALE_MESSAGE); }
    finally { setBusy(false); }
  }
  return <SaveStatusChip data-stale-recovery channels={[
    { key: "stale", announce: true, message: { text: recovery.document?.haltMessage ?? STALE_MESSAGE, tone: "bad",
      ...(!confirm ? { action: { label: "Reload", run: () => setConfirm(true) } } : {}) } },
    { key: "discard", message: confirm ? { text: DISCARD_MESSAGE, actions: [
      ...(notes.length ? [{ label: "Copy note text", run: () => void navigator.clipboard.writeText(notes.map(note => note.text).join("\n\n")) }] : []),
      { label: "Reload", run: () => void reload(), disabled: busy },
      { label: "Not now", run: () => setConfirm(false), disabled: busy },
    ] } : null },
    { key: "reload-error", announce: true, message: error ? { text: error, tone: "bad" } : null },
  ]} />;
}
