"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { deriveTableName } from "@/lib/ingest/naming";
import styles from "./SaveResultAsDataset.module.css";
import {
  runOperationToCompletion,
  type RunState,
} from "./operation-run-client";
import { Button } from "./ui/Button";
import { popoverTriggerProps, usePopoverDismiss } from "./ui/Popover";
import { useAnchored } from "./sql/use-anchored";

/**
 * Save a query result as a durable dataset.
 *
 * Three things this must not get wrong, each of them a defect a user meets on
 * their first attempt:
 *
 *  - **It saves the query that produced the result on screen**, not whatever
 *    the editor holds now. The caller passes the executed SQL; the editor's
 *    current draft is deliberately not reachable from here.
 *  - **It reports the name the dataset was actually registered under.** A
 *    requested name is sanitized into a SQL identifier, so "Bus stops 500 m"
 *    is stored as something else — a success message naming only what the user
 *    typed sends them looking for a table that does not exist.
 *  - **A slow save says so and cannot be started twice.** The run is
 *    asynchronous: the server accepts it and the work continues without the
 *    request, so this watches the run to a terminal state. The busy state is
 *    set on the press rather than when the acceptance returns — a gap there is
 *    exactly when a user presses again.
 *
 * Leaving the page stops the watching, not the run. The dataset still lands,
 * and the run list is where it can be found — which is the whole point of work
 * that outlives its request.
 *
 * The naming happens in a small panel anchored to the button, so the actions
 * beside it stay where they are; the confirmation is the host's to place — it
 * arrives through `onSaved`.
 */

export function SaveResultAsDataset({
  sql,
  suggestedName,
  onSaved,
}: {
  /** The SQL that produced the displayed result — never the editor draft. */
  sql: string;
  suggestedName: string;
  /** The registered name, once the dataset exists: the host
   * refreshes its table list so the new table shows without a reload, and
   * says where the dataset went. */
  onSaved?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const watching = useRef<AbortController | null>(null);
  useEffect(() => () => watching.current?.abort(), []);

  // Dismissal is the kit's popover contract: Escape and an outside
  // pointer close the panel — except while a save is in flight, when the
  // panel is the only place its progress is shown.
  const close = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);
  usePopoverDismiss({ open, onClose: close, contentRef: panelRef, triggerRef });
  // Placed in viewport coordinates, so a short results card cannot clip it.
  const pos = useAnchored(open, triggerRef, panelRef);

  /**
   * The single-flight guard, deliberately a ref rather than the `busy` state.
   *
   * React commits state on a later tick, so two presses landing in the *same*
   * tick both read `busy` as false and both start a run — two accepted jobs,
   * each doing the whole query. A browser smoke reproduced exactly that with
   * two synchronous clicks. The disabled attribute closes the human-speed case
   * and this closes the rest, because a ref updates the instant it is set.
   */
  const inFlight = useRef(false);

  async function save() {
    if (inFlight.current) return; // a second press while one is in flight is inert
    inFlight.current = true;
    // Busy from the press, not from the acceptance: no dead interval.
    setBusy(true);
    setPhase("queued");
    setError(null);
    const controller = new AbortController();
    watching.current = controller;
    try {
      const outcome = await runOperationToCompletion(
        { sql, name },
        { signal: controller.signal, onState: setPhase },
      );
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        setOpen(false);
        onSaved?.(outcome.name);
      } else {
        setError(outcome.message);
      }
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
      if (watching.current === controller) watching.current = null;
    }
  }

  // What the name will be stored under: the server's own sanitizer, shown
  // ahead of the save when it differs from what was typed.
  const stored = deriveTableName(name, new Set());
  return (
    <span className={styles.host}>
      <Button
        ref={triggerRef}
        variant="primary"
        // The trigger toggles the panel — except while a save is in
        // flight, when the panel stays, like Escape and an outside click.
        onClick={() => setOpen((o) => (busy ? o : !o))}
        {...popoverTriggerProps(panelId, open)}
      >
        Save as dataset
      </Button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className={styles.panel}
          role="group"
          aria-label="Save as dataset"
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
        >
          <label className={styles.field}>
            <span>Name for the new dataset</span>
            <input
              value={name}
              disabled={busy}
              autoFocus
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void save();
              }}
            />
          </label>
          {stored !== name.trim() && (
            <span className={styles.storedAs} role="status">
              stored as <code>{stored}</code>
            </span>
          )}
          {error && (
            <span className={styles.why} role="alert">
              {error}
            </span>
          )}
          <div className={styles.acts}>
            <Button variant="quiet" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void save()}>
              {busy ? (phase === "queued" ? "Waiting…" : "Saving…") : "Save"}
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}
