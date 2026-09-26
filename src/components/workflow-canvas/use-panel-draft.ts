"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { WorkflowStep } from "../workflow-model";
import { activeParameters, registeredName } from "../builder/drawer/operation-form";
import { useEdits } from "./edits-context";
import { makePending, type Waiting } from "./panel-pending";
import { makeSessions } from "./panel-session";
import { useRunner } from "./run-context";
import type { EditOutcome } from "./use-recipe-edits";

/**
 * The panel's draft (extracted from the panel, where a field's focus
 * session is minted): the node's effective definition as typed,
 * re-seeded when the node changes under the panel unless a send is
 * pending; each valid change sent after a short debounce through the
 * edit coordinator, a refused one keeping the field's value with the
 * API's reason at the field, a locally invalid one never sent; the flush
 * a close or a run lands what still waits with; Discard edit dropping
 * what waits in the debounce too; and the draft as it stands for a copy.
 * What is typed stays typed. The session itself is `panel-session`'s
 * rule; this hook reads the focused element and reports focus leaving
 * it.
 */

/** Long enough to swallow a typed word, short enough to feel saved as made. */
const SEND_MS = 400;
const subscribeNever = () => () => {};
const noDraft = () => null;

export type Draft = Record<string, unknown>;

export function usePanelDraft({ step, operation, effective }: { step: WorkflowStep; operation: OperationDef | null; effective: Draft }) {
  const edits = useEdits();
  const readUnresolved = useCallback(() => edits.drafts?.get(step.id) ?? null, [edits, step.id]);
  const unresolved = useSyncExternalStore(edits.drafts?.subscribe ?? subscribeNever, readUnresolved, noDraft);
  // The draft: the effective definition, re-seeded when the node changes
  // under the panel (another node selected, or an accepted edit's read),
  // unless a send is pending for this node.
  const [draft, setDraft] = useState<{ of: string; values: Draft }>({ of: step.id, values: unresolved?.outcome ? unresolved.displayValues : effective });
  // Whether a typed change still waits to be sent; while it does, a read of
  // the node under the panel never overwrites what was typed.
  const [dirty, setDirty] = useState(false);
  // The debounce slot lives in `panel-pending`; how many sends are on the
  // wire or queued in the node's lane is counted here: the draft stays
  // dirty until the last of them settles. The focus session rides with
  // each send: a field's edits made without focus leaving it are one
  // step.
  const inflight = useRef(0);
  // Made once for the panel's life (the panel remounts per node); the
  // send a fired delay makes is set from an effect below.
  const pending = useMemo(() => makePending(SEND_MS), []);
  /** The focus sessions this panel's fields are edited in; their rule
   * lives in `panel-session`. */
  const sessions = useMemo(() => makeSessions(), []);
  /** The session a change belongs to, minted at the keystroke: the same
   * one while the same field is edited with focus where it was. */
  const sessionFor = (at: string): string => sessions.mint(at, typeof document === "undefined" ? null : document.activeElement);
  // Focus leaving a field ends its session, so the same field returned to
  // is a second one and takes a second press to undo. Without this a
  // field left and come back to by the keyboard, which seals nothing,
  // merged both runs into one step.
  useEffect(() => {
    const onOut = (e: FocusEvent) => sessions.left(e.target);
    document.addEventListener("focusout", onOut, true);
    return () => document.removeEventListener("focusout", onOut, true);
  }, [sessions]);
  // What the visible draft cannot save (an out-of-bounds value, a refused
  // name): a run asked while it stands is refused with this, never run
  // over an older payload.
  const invalidRef = useRef<string | null>(null);
  const seed = JSON.stringify({ effective, unresolved: unresolved?.revision ?? null });
  const [seeded, setSeeded] = useState({ of: step.id, seed });
  if (seeded.of !== step.id || seeded.seed !== seed) {
    setSeeded({ of: step.id, seed });
    if (draft.of !== step.id || (!dirty && (!unresolved || unresolved.outcome)))
      setDraft({ of: step.id, values: unresolved?.outcome ? unresolved.displayValues : effective });
    if (draft.of !== step.id) setDirty(false);
  }
  const values = !dirty && unresolved?.outcome ? unresolved.displayValues : draft.of === step.id ? draft.values : effective;

  const refusals = unresolved?.refusals ?? {};
  const dispatch = useCallback(
    ({ values: sent, at, session: of }: Waiting): Promise<EditOutcome> => {
      inflight.current += 1;
      return edits.edit(step.id, sent, { field: at, session: of }).then((outcome: EditOutcome) => {
        inflight.current -= 1;
        if (!pending.waiting() && inflight.current === 0) setDirty(false);
        return outcome;
      });
    },
    [edits, pending, step.id],
  );
  useEffect(() => {
    pending.setDispatch((waiting) => void dispatch(waiting));
  }, [dispatch, pending]);
  const send = (next: Draft, at: string) => {
    pending.offer(next, at, sessionFor(at));
    setDirty(true);
  };
  // A change made moments before the panel closes is sent, not lost:
  // the debounce is economy, never a condition on saving.
  const flush = useCallback((): Promise<EditOutcome | null> => {
    const waiting = pending.take();
    // The draft on screen is what would run; if it cannot be saved as it
    // stands, nothing older is sent in its place.
    if (invalidRef.current) return Promise.resolve({ kind: "failed", message: invalidRef.current });
    return waiting ? dispatch(waiting) : Promise.resolve(null);
  }, [dispatch, pending]);
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => () => void flushRef.current(), []);
  // A run started anywhere lands what is typed here first: the runner
  // holds this panel's flush while it is open.
  const runner = useRunner();
  useEffect(() => {
    runner.setFlush(() => flushRef.current());
    return () => runner.setFlush(null);
  }, [runner]);
  // The draft as it stands, for a copy: the values that would be sent, or
  // why they cannot be.
  const sentRef = useRef<Record<string, unknown>>({});
  const refusalsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    // Locally invalid, or refused by the API as it stands: either copies nothing.
    runner.setDraft(() => ({ values: sentRef.current, invalid: invalidRef.current ?? Object.values(refusalsRef.current)[0] ?? null }));
    return () => runner.setDraft(null);
  }, [runner]);
  // Discard drops what waits in the debounce too: a timer firing after
  // the discard would put the edit straight back.
  const discard = () => {
    pending.take();
    setDirty(false);
    void edits.discard(step.id);
  };

  const set = (name: string, value: unknown, valid: boolean) => {
    const next = { ...values, [name]: value };
    setDraft({ of: step.id, values: next });
    edits.drafts?.hold(step.id, next, name);
    if (!valid) {
      // An invalid value supersedes whatever waited: the older payload
      // must not land, or run, in its place.
      pending.take();
      setDirty(false);
      return;
    }
    // The request carries the active definition — a value a hidden,
    // irrelevant parameter still holds in the draft is never sent — with
    // the name in its registered form.
    const active = operation ? activeParameters(operation, next) : next;
    send(name === "name" ? { ...active, name: registeredName(String(value)) } : active, name);
  };

  /** What the panel cannot save as it stands, or null: kept current by the panel's own rules. */
  const setInvalid = useCallback((reason: string | null) => {
    invalidRef.current = reason;
    edits.drafts?.invalid(step.id, reason);
  }, [edits, step.id]);
  // The definition the draft would send: the active parameters of what is typed.
  const sent = operation ? activeParameters(operation, values) : values;
  useEffect(() => {
    sentRef.current = sent;
    refusalsRef.current = refusals;
  });

  return { values, refusals, set, discard, sent, setInvalid };
}
