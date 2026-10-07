"use client";
import { createContext, useContext, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { GuardMessage, LeaveGuard } from "./leave-guard";
import styles from "./SettingsCard.module.css";

/** The leave guard of the Settings page on screen; none outside it. */
export const GuardContext = createContext<LeaveGuard | null>(null);

/**
 * A card's report to the leave guard: it holds the page while `holding`
 * (unsaved typed text, or something that must not be dropped silently,
 * said in `note`), and lets go when it stops holding or leaves the page.
 */
export function useGuardEntry(id: string, holding: boolean, title: string, note?: string) {
  const guard = useContext(GuardContext);
  useEffect(() => {
    guard?.set(id, holding ? { title, ...(note ? { note } : {}) } : null);
  }, [guard, id, holding, title, note]);
  useEffect(() => () => guard?.remove(id), [guard, id]);
}

/** "Discard unsaved changes?", naming the cards that hold the page. */
export function LeaveDialog({ message, onAnswer }: { message: GuardMessage; onAnswer: (discard: boolean) => void }) {
  return <Dialog label="Unsaved changes" className={styles.dialog} onClose={() => onAnswer(false)}>
    <h2>{message.title}</h2>
    {message.body.map(line => <p key={line}>{line}</p>)}
    <div className={styles.actions}>
      <Button variant="danger" onClick={() => onAnswer(true)}>{message.discard}</Button>
      <Button onClick={() => onAnswer(false)}>{message.keep}</Button>
    </div>
  </Dialog>;
}
