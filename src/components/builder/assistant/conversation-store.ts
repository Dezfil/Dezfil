import type { PendingReceipt } from "@/lib/assistant/runs";
import { emptyTurn, type LiveTurn, type Turn, type TurnOrigin } from "./assistant-turn-state";
import type { PaneFailure } from "./assistant-words";
import { onPrivateReset, privateStateOpen } from "../../auth/private-state";

/**
 * The conversation, as browser state retained across same-tab
 * navigation: one shared conversation across the builder, /sql and the
 * workflow canvas, held in this module for the tab's life and stored
 * nowhere else. A pane mounts on each page and reads it; navigation
 * departs an in-flight execution as requires, and the turn that was
 * departed, its recovery door and a parked confirmation are here for
 * the next page's pane to show. The "talking about" chips are the
 * page's, not the conversation's.
 */

export interface ActiveTurn {
  id: string;
  message: string;
  origin?: TurnOrigin;
}

export interface ConversationState {
  turns: Turn[];
  input: string;
  live: LiveTurn;
  busy: boolean;
  /** The flight in progress is an observational recovery read, not
   * execution: the ordinary controls stay. */
  reading: boolean;
  /** The status region's sentences for the current turn, in order (spec
   * item 3): filled from the event sequence and the receipt, started over
   * when a turn starts. */
  announcements: string[];
  recoveryId: string | null;
  /** The failure the pane shows, with its code. */
  error: PaneFailure | null;
  availablePending: PendingReceipt[];
}

const initial = (): ConversationState => ({ turns: [], input: "", live: emptyTurn(), busy: false, reading: false, announcements: [], recoveryId: null, error: null, availablePending: [] });

/** The reload locator: the active run's identity, its
 * originating message and its origin (the page, and on /sql the draft
 * the proposal's Insert compares against), held in the tab's session
 * storage from before dispatch until the run settles or becomes
 * unavailable. Bounded by what it holds: a submission is at most 128 KiB
 * and a context 64 KiB. Nothing is stored beyond the tab, and a closed
 * tab loses the turn, which is the working-state contract. */
export const LOCATOR_KEY = "dezfil.assistant.active";
type Locator = Pick<ActiveTurn, "id" | "message" | "origin">;
function readLocator(): Locator | null {
  if (!privateStateOpen()) return null;
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(LOCATOR_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Locator;
    return typeof value?.id === "string" && typeof value.message === "string" ? value : null;
  } catch { return null; }
}
function writeLocator(value: Locator | null) {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (value) sessionStorage.setItem(LOCATOR_KEY, JSON.stringify({ id: value.id, message: value.message, ...(value.origin ? { origin: value.origin } : {}) }));
    else sessionStorage.removeItem(LOCATOR_KEY);
  } catch { /* A tab whose storage refuses keeps its memory-only state. */ }
}

export class ConversationStore {
  private state: ConversationState = initial();
  private listeners = new Set<() => void>();
  private current: ActiveTurn | null = null;
  /** True when this store started from a locator the tab kept: the page
   * was reloaded during a run, and the pane recovers it once on mount. */
  restored = false;
  constructor() {
    const locator = readLocator();
    if (locator) { this.current = { ...locator }; this.restored = true; }
  }
  /** The request in flight or awaiting its outcome read. Assigning it
   * writes the locator before dispatch; clearing it clears the locator. */
  get active(): ActiveTurn | null { return this.current; }
  set active(value: ActiveTurn | null) {
    if (!privateStateOpen()) return;
    this.current = value;
    writeLocator(value);
  }
  /** The message and origin of the request whose confirmation is pending. */
  pendingMessage = "";
  pendingOrigin: TurnOrigin | undefined = undefined;
  /** The execution stream's controller: departure aborts it. */
  flight: AbortController | null = null;
  /** The pending action the pane's Stop ended, so
   * its settled entry is worded for a stopped request. */
  stoppedPending: string | null = null;
  /** A Stop pressed while the card had arrived but the stream's outcome
   * read was still in flight: the abandonment follows once it settles. */
  stopAfterFlight: string | null = null;
  /** One submission, resolution or recovery at a time. */
  locked = false;

  get = (): ConversationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Add sentences to the status region's list. */
  announce(...sentences: string[]) {
    if (sentences.length) this.set((s) => ({ announcements: [...s.announcements, ...sentences] }));
  }
  set(patch: Partial<ConversationState> | ((state: ConversationState) => Partial<ConversationState>)) {
    if (!privateStateOpen()) return;
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  /**
   * End the conversation: the turns with the record entries they retain,
   * the live turn and the draft all go, and the next message composes its
   * history from an empty settled list, so the model sees nothing of what
   * came before.
   *
   * It touches nothing the server holds and dispatches nothing: the
   * control is offered only where no run is outstanding, so there is
   * never anything here to cancel or abandon. The pane's own remembered
   * model and effort are not the conversation's and are left alone.
   */
  clear() {
    this.set({ turns: [], live: emptyTurn(), input: "", announcements: [], error: null });
  }
  reset() {
    this.flight?.abort();
    this.state = initial();
    this.current = null; writeLocator(null); this.restored = false; this.pendingMessage = ""; this.pendingOrigin = undefined; this.flight = null; this.locked = false; this.stoppedPending = null; this.stopAfterFlight = null;
    for (const listener of this.listeners) listener();
  }
  resetForTests() { this.reset(); }
}

/** The tab's one conversation. */
export const conversation = new ConversationStore();
onPrivateReset(() => conversation.reset());
