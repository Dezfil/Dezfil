"use client";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DocumentEditorContext } from "../../document-editor-context";
import type { AssistantContext } from "@/lib/assistant/context";
import type { AssistantEvent } from "@/lib/assistant/loop";
import type { PendingReceipt, RunReceipt } from "@/lib/assistant/runs";
import { readApiFailure } from "../../api";
import type { PaneFailure } from "./assistant-words";
import { emptyTurn, messageAfterFailure, originOf, receiveEvent, type LiveTurn, type Status } from "./assistant-turn-state";
import { conversation } from "./conversation-store";
import { boundFor, choicePayload, reconcile } from "./model-choice";
import { modelChoice } from "./model-choice-store";
import { failed, json, note, RequestError, runPath } from "./assistant-transport";
import { useAssistantRecovery } from "./use-assistant-recovery";
import type { InsertOutcome } from "./ProposalBlock";
import { turnPhase } from "./turn-phase";
import { CONTINUING, TURN_STARTED, eventAnnouncements } from "./turn-announcements";

/** Transport ownership, recovery and transcript state, over the tab's one
 * conversation: the transcript, the live turn, the recovery door and the pending
 * confirmation live in the store and survive same-tab navigation; a mounted pane
 * reads them. Dismissal does not unmount this hook; actual page departure aborts
 * its owned execution request, and the outcome read that follows lands in the
 * store for the next page's pane. Recovery is the recovery hook's
 * (use-assistant-recovery.ts), composed here: it only reads the documented API
 * and never repeats a message or approval. Stop is two documented operations
 * behind one control: cancellation while the turn executes, and the pending-turn
 * abandonment while a card waits, which settles the run with the parked action
 * not done; the person then writes a new message. The pane no longer sends while
 * a card waits, so supersession stays the API's for headless clients. */
export function useAssistantTurn(context: AssistantContext | undefined, onMutate: () => void) {
  const editor = useContext(DocumentEditorContext);
  const refreshAfterRecovery = useCallback(() => { if (!editor) onMutate(); }, [editor, onMutate]);
  const store = conversation;
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { turns, input, live, busy, reading, announcements, recoveryId, error, availablePending } = state;
  // The pane's phase: execution and a parked card wear the running
  // controls, a recovery read the ordinary ones.
  const phase = turnPhase({ busy, reading, pending: live.pending });
  const [status, setStatus] = useState<Status>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [statusAttempt, setStatusAttempt] = useState(1);
  const setInput = useCallback((value: string) => store.set({ input: value }), [store]);
  const setError = useCallback((value: PaneFailure | null) => store.set({ error: value }), [store]);
  const replace = useCallback((value: LiveTurn) => store.set({ live: value }), [store]);
  const pendingList = useCallback(async () => {
    const result = await json<{ pending: PendingReceipt[] }>("/api/assistant/pending");
    store.set({ availablePending: result.pending });
  }, [store]);
  useEffect(() => {
    let cancelled = false;
    void json<Exclude<Status, null>>("/api/assistant").then((value) => {
      if (!cancelled) { setStatus(value); setStatusFailed(false); }
    }).catch(() => { if (!cancelled) setStatusFailed(true); });
    return () => { cancelled = true; };
  }, [statusAttempt]);

  const { applyReceipt, readOutcome, recover: recoverUnordered } = useAssistantRecovery({ recoveryId, onMutate: refreshAfterRecovery, replace, pendingList });
  const recover = useCallback((id?: string) => {
    const work = () => recoverUnordered(id);
    return editor ? editor.turn(work) : work();
  }, [editor, recoverUnordered]);
  /** Read through a ref by the mount effect, whose dependencies stay the
   * mount's: re-running it would abort the flight it cleans up. */
  const recoverRef = useRef(recover);
  recoverRef.current = recover;

  useEffect(() => {
    void json<{ pending: PendingReceipt[] }>("/api/assistant/pending").then((result) => store.set({ availablePending: result.pending }))
      .catch(() => store.set({ error: note("Pending actions couldn't be read. Reload this page to check them.") }));
    // A reload during a run: the tab kept the locator, so the pane
    // recovers the turn once, through the documented read alone; nothing
    // is dispatched and no message is repeated.
    if (store.restored && store.active && !store.locked) {
      store.restored = false;
      void recoverRef.current(store.active.id);
    }
    // Page departure (never dismissal: the pane stays mounted while
    // closed) aborts the execution stream; the outcome read that follows
    // records in the store, so the next page shows what was departed.
    return () => { store.flight?.abort(); };
  }, [pendingList, store]);

  const streamUnordered = useCallback(async (payload: Record<string, unknown>, fresh: boolean) => {
    const current = store.active!;
    store.set({ recoveryId: current.id });
    const controller = new AbortController(); store.flight = controller;
    /** The route answered this submission with a refusal of its own, so the
     * person has been told why. */
    let reported = false;
    try {
      const response = await fetch("/api/assistant/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) {
        const failure = await readApiFailure(response);
        if (failure.code === "stale_revision") editor?.sequence.halt();
        reported = true;
        throw new RequestError(failure.code, failure.message, response.status);
      }
      // The provisional message stays where it was sent; the turn's own
      // text, actions and card start empty. The pair this submission bound
      // stays with it, so the run keeps it from the moment it starts and
      // not only from the receipt that settles it (PR).
      if (fresh) replace({ ...emptyTurn(), message: current.message, origin: current.origin, runId: current.id,
        ...(store.get().live.choice ? { choice: store.get().live.choice } : {}) });
      else replace({ ...store.get().live, pending: null });
      if (response.headers.get("content-type")?.includes("application/json")) {
        await applyReceipt(await response.json());
        return;
      }
      if (!response.body) throw new Error("The assistant response was empty.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
          if (!line) continue;
          const event = JSON.parse(line) as AssistantEvent;
          if ((event.type === "error" && event.code === "stale_revision") ||
              (event.type === "tool_result" && (event.body as { error?: { code?: string } } | null)?.error?.code === "stale_revision")) editor?.sequence.halt();
          const next = receiveEvent(store.get().live, event, current.id);
          replace(next);
          // The region hears each event as it is applied, whatever the render cadence.
          store.announce(...eventAnnouncements(next, event));
          if (event.type === "error") store.set({ error: { code: event.code, message: event.message } });
        }
      }
    } catch (e) {
      store.set({ error: failed(e, "The assistant connection was interrupted.") });
    } finally {
      if (store.flight === controller) store.flight = null;
    }
    // A closed stream does not prove completion. Always reconcile with the
    // server-owned receipt, including a stream lost before its first event.
    try { await readOutcome(current.id, reported); }
    catch (e) { store.set({ error: failed(e, "Check the request outcome to recover this turn.") }); }
  }, [applyReceipt, readOutcome, replace, store, editor]);

  const stream = useCallback((payload: Record<string, unknown>, fresh: boolean) => {
    const work = () => streamUnordered(payload, fresh);
    return editor ? editor.turn(work) : work();
  }, [editor, streamUnordered]);

  /** The flight's end, read through a ref: it is defined with Stop below. */
  const afterFlightRef = useRef<() => void>(() => { store.locked = false; store.set({ busy: false }); });
  /** Send these words as the person's message; the input's are the
   * default, an entry chip's the other way in. */
  const submitText = useCallback(async (text: string) => {
    const message = text.trim();
    // A parked turn takes no message (the field ruling): Stop first.
    if (!message || store.locked || store.get().recoveryId || store.get().live.pending) return;
    store.locked = true; store.set({ busy: true, error: null, announcements: [TURN_STARTED] });
    const origin = originOf(context);
    // The message enters the transcript at once, while the reservation is
    // still out; the draft clears with it. History is composed from the
    // settled list alone, so the message reaches the model once, as the
    // request's own message. The pair this message binds, read once at
    // submission so a pick made while the turn runs belongs to the next
    // message. Read against the status actually held, so a pair the
    // instance no longer offers falls back here exactly as it does on the
    // chip. Read against the instance this pane actually knows of, so a
    // pair it cannot show — no list, one model, or no status read —
    // neither travels nor binds.
    const instanceModel = status?.enabled ? status.model : undefined;
    const offered = status?.enabled ? status.models ?? [] : [];
    const remembered = reconcile(offered, modelChoice.get(), instanceModel);
    const bound = boundFor(remembered, instanceModel);
    replace({ ...emptyTurn(), message, origin, ...(bound ? { choice: bound } : {}) });
    store.set({ input: "" });
    const reserving = new AbortController(); store.flight = reserving;
    try {
      const reservation = await json<RunReceipt>("/api/assistant/runs", { method: "POST", signal: reserving.signal });
      store.active = { id: reservation.id, message, origin };
      replace({ ...store.get().live, runId: reservation.id });
      const history = store.get().turns.map(({ role, text }) => ({ role, text }));
      await stream({ runId: reservation.id, message, history, ...(context ? { context } : {}), ...choicePayload(remembered) }, true);
    } catch (e) {
      // No run was reserved: the provisional message goes back to the
      // draft, so the words stand in one place and a retry is deliberate.
      if (messageAfterFailure(store.active, message) === "draft") { replace(emptyTurn()); store.set({ input: message }); }
      store.set({ error: failed(e, "The request couldn't be reserved.") });
    }
    finally { if (store.flight === reserving) store.flight = null; afterFlightRef.current(); }
  }, [context, replace, status, store, stream]);
  const submit = useCallback(() => submitText(input), [input, submitText]);
  const resolve = useCallback(async (approved: boolean) => {
    const pending = store.get().live.pending;
    if (!pending || store.locked) return;
    store.locked = true; store.set({ busy: true, error: null });
    store.announce(CONTINUING);
    store.active = { id: pending.runId, message: store.pendingMessage, origin: store.pendingOrigin };
    try { await stream({ resolution: { pending: pending.id, approved } }, false); }
    finally { afterFlightRef.current(); }
  }, [store, stream]);
  /** Stop. While a card waits: the documented abandonment settles the run
   * with the parked action not done, and the pane words that line for a
   * stopped request. While the turn executes: cancellation, the flight
   * aborted, the outcome read as always. */
  const stop = useCallback(async () => {
    const parked = store.get().live.pending;
    if (parked && store.get().busy) {
      // The card arrived but the stream's outcome read is still in flight:
      // the press is kept and the abandonment follows once it settles.
      store.stopAfterFlight = parked.id;
      store.flight?.abort();
      return;
    }
    if (parked) {
      if (store.locked) return;
      store.locked = true; store.set({ busy: true, error: null });
      store.stoppedPending = parked.id;
      store.active = { id: parked.runId, message: store.pendingMessage, origin: store.pendingOrigin };
      try { await applyReceipt(await json<RunReceipt>(runPath(parked.runId), { method: "DELETE" })); }
      catch (e) {
        // An ambiguous failure: the abandonment
        // may have landed with its response lost. The card leaves, the run's
        // receipt is the authority, and if that read fails too the recovery
        // door stays, leading to the same read; a retry never pretends the
        // card is still open.
        replace({ ...store.get().live, pending: null });
        store.set({ recoveryId: parked.runId });
        try { await readOutcome(parked.runId); }
        catch (read) { store.set({ error: failed(read, "The request couldn't be stopped. Check its outcome.") }); void e; }
      }
      finally { store.locked = false; store.set({ busy: false }); }
      return;
    }
    const id = store.active?.id;
    if (id) void json(`${runPath(id)}/cancel`, { method: "POST" }).catch(() => {});
    store.flight?.abort();
  }, [applyReceipt, readOutcome, replace, store]);
  /** A flight ended: a Stop kept while it was in flight now runs. */
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const afterFlight = useCallback(() => {
    store.locked = false; store.set({ busy: false });
    const kept = store.stopAfterFlight; store.stopAfterFlight = null;
    if (kept && store.get().live.pending?.id === kept) void stopRef.current();
  }, [store]);
  afterFlightRef.current = afterFlight;
  /** A proposal was inserted: the turn remembers how, so the block says so. */
  const markInserted = useCallback((runId: string, index: number, outcome: InsertOutcome) => {
    store.set((s) => ({ turns: s.turns.map((t) => t.role === "assistant" && t.runId === runId ? { ...t, inserted: { ...t.inserted, [index]: outcome } } : t) }));
  }, [store]);
  return { status, statusFailed, setStatusFailed, setStatusAttempt, turns, input, setInput, busy, phase, announcements,
    live, streaming: live.segment !== undefined, error, setError,
    submit, submitText, resolve, recoveryId, recover, stop, availablePending, markInserted };
}
