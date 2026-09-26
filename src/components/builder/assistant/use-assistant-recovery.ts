"use client";
import { useCallback } from "react";
import type { RunReceipt } from "@/lib/assistant/runs";
import { requiresRefresh } from "./assistant-event-metadata";
import type { PaneFailure } from "./assistant-words";
import { completedTurns, emptyTurn, recoveredTurn, type LiveTurn } from "./assistant-turn-state";
import { mergeLiveDetail, wordStoppedGate } from "./record-projection";
import { settlementAnnouncements, terminalWords } from "./turn-announcements";
import { conversation } from "./conversation-store";
import { failed, json, note, RequestError, runPath } from "./assistant-transport";

/**
 * The recovery state (observational recovery): a run's documented receipt
 * applied to the tab's conversation. Recovery only reads; it never
 * repeats a message or an approval. A settled turn keeps its entries
 * (item 1), the recovered actions keep the detail this tab streamed where
 * the receipt holds none, and the pane's failure after a recovery read
 * carries the receipt's own code (item 4).
 */
export function useAssistantRecovery(
  deps: { recoveryId: string | null; onMutate: () => void; replace: (value: LiveTurn) => void; pendingList: () => Promise<void> },
) {
  const store = conversation;
  const { recoveryId, onMutate, replace, pendingList } = deps;

  /** `reported`: this submission's outcome was already reported to the
   * person by the route that refused it. */
  const applyReceipt = useCallback(async (receipt: RunReceipt, reported = false) => {
    const current = store.active;
    if (!current || current.id !== receipt.id) return;
    if (receipt.state === "reserved") {
      // Nothing was bound. Release the unused slot and restore the draft, so
      // any future submission is a deliberate action.
      await json(runPath(receipt.id), { method: "DELETE" });
      replace(emptyTurn());
      store.set({ input: current.message });
      store.active = null; store.set({ recoveryId: null });
      // The note is for the case where nothing said why: a refusal already
      // reported for this submission stands, so the person reads the reason
      // and not only that nothing happened.
      if (!reported) store.set({ error: note("The message wasn't started. You can send it again.") });
      return;
    }
    const streamed = store.get().live;
    const read = recoveredTurn(receipt);
    // The receipt keeps no result body: a refusal's own text stays from the
    // stream this tab saw. The turn's message and run stay on the live
    // turn: a parked or still-settling turn keeps its view. A gate this
    // pane's Stop ended is worded for a stopped request.
    const recovered = { ...read, actions: wordStoppedGate(mergeLiveDetail(read.actions, streamed.actions), store.stoppedPending), runId: receipt.id,
      ...(current.message ? { message: current.message } : {}), ...(current.origin ? { origin: current.origin } : {}) };
    store.stoppedPending = null;
    replace(recovered);
    if (requiresRefresh(receipt.actions)) onMutate();
    if (receipt.state === "running") {
      store.set({ recoveryId: receipt.id, error: note("The request is still settling. Check its outcome before starting another turn.") });
      return;
    }
    store.set({ recoveryId: null });
    if (receipt.pending) {
      store.pendingMessage = current.message;
      store.pendingOrigin = current.origin;
    } else {
      store.set((s) => ({ turns: [...s.turns.filter((t) => t.runId !== receipt.id), ...completedTurns(receipt.id, current.message, recovered, current.origin)] }));
      // The settled turn holds its message and entries now; the live turn
      // empties under the same run's key.
      replace(emptyTurn());
      store.active = null;
      // The outcomes the stream did not carry, then the terminal outcome.
      store.announce(...settlementAnnouncements(streamed.actions, recovered.actions, receipt.state));
    }
    // The recovery path keeps the receipt's own code.
    const outcome: PaneFailure | null = receipt.error ? { code: receipt.error.code, message: receipt.error.message }
      : receipt.state === "interrupted" ? note("The request stopped. Recorded actions show what completed. Send a new message to continue.")
      : receipt.state === "unavailable" ? note("This request is no longer available. It will not be repeated.") : null;
    const trimmed = receipt.incomplete ? "Some text or arguments were omitted from this recovery record." : null;
    store.set({ error: outcome ? { ...outcome, message: [outcome.message, trimmed].filter(Boolean).join(" ") } : trimmed ? note(trimmed) : null });
    await pendingList();
  }, [onMutate, pendingList, replace, store]);

  const readOutcome = useCallback(async (id: string, reported = false) => {
    try { await applyReceipt(await json<RunReceipt>(runPath(id)), reported); }
    catch (e) {
      if (e instanceof RequestError && e.status === 404) {
        store.set({ recoveryId: null }); store.active = null;
        const gone = terminalWords("unavailable"); if (gone) store.announce(gone);
        // No run owns the pane now, so its bound pair goes with it: a pair
        // no run holds would go on locking the picker over a composer that
        // will take the next message.
        replace({ ...store.get().live, pending: null, choice: undefined });
        await pendingList();
      }
      throw e;
    }
  }, [applyReceipt, pendingList, replace, store]);

  const recover = useCallback(async (id = recoveryId ?? undefined) => {
    if (!id || store.locked) return;
    // An observational read: busy, but not executing.
    store.locked = true; store.set({ busy: true, reading: true, error: null });
    store.active ??= { id, message: "" };
    store.set({ recoveryId: id });
    try { await readOutcome(id); }
    catch (e) { store.set({ error: failed(e, "The request outcome couldn't be read.") }); }
    finally { store.locked = false; store.set({ busy: false, reading: false }); }
  }, [readOutcome, recoveryId, store]);

  return { applyReceipt, readOutcome, recover };
}
