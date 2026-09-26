import type { PendingReceipt } from "@/lib/assistant/runs";
import type { ActionDownload } from "./assistant-downloads";
import type { LiveTurn, Turn, TurnOrigin } from "./assistant-turn-state";
import type { InsertOutcome } from "./ProposalBlock";
import type { RecordEntry } from "./record-projection";

/**
 * One view per turn: the settled transcript's user and assistant turns
 * paired by their run, and the live turn, each keyed by the run's
 * identity so settlement changes the view's data and not its identity.
 * The record is read above the answer, live and settled alike. Pure; the
 * pane renders the views.
 */
export interface TurnView {
  /** The run's identity, or a provisional key before a run is reserved. */
  key: string;
  runId?: string;
  message?: string;
  origin?: TurnOrigin;
  text: string;
  entries: RecordEntry[];
  pending: PendingReceipt | null;
  downloads?: ActionDownload[];
  inserted?: Record<number, InsertOutcome>;
  live: boolean;
}

export const LIVE_KEY = "live";

/** Whether the live turn holds anything to show. */
export function liveTurnShown(live: LiveTurn): boolean {
  return live.message !== undefined || live.text !== "" || live.actions.length > 0 || live.pending !== null;
}

export function turnViews(turns: Turn[], live: LiveTurn): TurnView[] {
  const views: TurnView[] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index];
    const next = turns[index + 1];
    if (turn.role === "user" && next?.role === "assistant" && next.runId === turn.runId) {
      views.push({ key: turn.runId ?? `turn-${index}`, runId: turn.runId, message: turn.text, origin: next.origin ?? turn.origin, text: next.text, entries: next.entries ?? [], pending: null, downloads: next.downloads, inserted: next.inserted, live: false });
      index += 2;
      continue;
    }
    if (turn.role === "assistant") {
      views.push({ key: turn.runId ?? `turn-${index}`, runId: turn.runId, origin: turn.origin, text: turn.text, entries: turn.entries ?? [], pending: null, downloads: turn.downloads, inserted: turn.inserted, live: false });
    } else {
      views.push({ key: turn.runId ? `${turn.runId}:message` : `turn-${index}`, runId: turn.runId, message: turn.text, origin: turn.origin, text: "", entries: [], pending: null, live: false });
    }
    index += 1;
  }
  if (liveTurnShown(live)) {
    views.push({ key: live.runId ?? LIVE_KEY, runId: live.runId, message: live.message, origin: live.origin, text: live.text, entries: live.actions, pending: live.pending, live: true });
  }
  return views;
}
