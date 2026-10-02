"use client";
import { useState } from "react";
import { SaveStatusChip } from "../ui/SaveStatusChip";
import { STALE_MESSAGE } from "../document-sequence";
import { useUnsavedNavigation } from "../use-unsaved-navigation";
import { useCanvasRecovery } from "./WorkflowRecovery";

export function CanvasStaleStatus() {
  const recovery = useCanvasRecovery();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedNavigation(recovery.stale);
  const notes = (recovery.document?.draftLayout?.notes ?? []).filter(note =>
    note.text !== recovery.document?.layout?.notes.find(saved => saved.id === note.id)?.text);
  async function reload() {
    setBusy(true); setError(null);
    try { await recovery.recover?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : STALE_MESSAGE); }
    finally { setBusy(false); }
  }
  return <SaveStatusChip data-stale-recovery channels={[
    { key: "stale", announce: true, message: { text: STALE_MESSAGE, tone: "bad",
      ...(!confirm ? { action: { label: "Reload", run: () => setConfirm(true) } } : {}) } },
    { key: "discard", message: confirm ? { text: "Reload discards your unsaved changes. Copy what you want to keep first.", actions: [
      ...(notes.length ? [{ label: "Copy note text", run: () => void navigator.clipboard.writeText(notes.map(note => note.text).join("\n\n")) }] : []),
      { label: "Reload", run: () => void reload(), disabled: busy },
      { label: "Not now", run: () => setConfirm(false), disabled: busy },
    ] } : null },
    { key: "reload-error", announce: true, message: error ? { text: error, tone: "bad" } : null },
  ]} />;
}
