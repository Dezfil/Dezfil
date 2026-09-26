/**
 * The panel's pending send: a valid change waits a short debounce, long
 * enough to swallow a typed word and short enough to feel saved as made,
 * the newest value of the field replacing the one waiting; a flush takes
 * what waits and sends it at once, and an invalid value or a discard
 * takes it and drops it. The focus session rides with the value, so the
 * record folds a field's sends into one step, and a change in another
 * field or session sends what waited first, so each session stays its
 * own step. Extracted from the panel's draft hook at review, so the rule
 * has a test of its own; the timers are handed in, so a test drives the
 * clock. Nothing of React or the DOM.
 */
export type Draft = Record<string, unknown>;

/** A change waiting to be sent: the draft's active values, the field it
 * came from and the focus session it was typed in. */
export interface Waiting {
  values: Draft;
  at: string;
  session: string | null;
}

export interface PendingSend {
  /** A valid change made: waits its delay, replacing what waited. */
  offer: (values: Draft, at: string, session: string | null) => void;
  /** What waits, taken out without being sent; null when nothing waits. */
  take: () => Waiting | null;
  /** Whether a change waits. */
  waiting: () => boolean;
  /** The send a fired delay makes: the panel's newest, set from an
   * effect as the coordinator's ports are, never read at render. */
  setDispatch: (dispatch: (waiting: Waiting) => void) => void;
}

type Handle = ReturnType<typeof setTimeout>;
interface Timers {
  set: (fn: () => void, ms: number) => Handle;
  clear: (handle: Handle) => void;
}
const clock: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) };

export function makePending(delay: number, timers: Timers = clock): PendingSend {
  let dispatch: (waiting: Waiting) => void = () => undefined;
  let timer: Handle | null = null;
  let held: Waiting | null = null;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const take = (): Waiting | null => {
    stop();
    const waiting = held;
    held = null;
    return waiting;
  };
  return {
    offer: (values, at, session) => {
      // A change in another field, or in another focus session of the
      // same one, sends what waited first, under its own field and
      // session: one slot carrying both under the second's session made
      // one step of two sessions, and one undo reverted both. The values
      // carry the whole draft, so the second send holds the first's
      // change too; the record measures its step from the first's answer.
      const waiting = held;
      if (waiting && (waiting.at !== at || waiting.session !== session)) dispatch(take()!);
      stop();
      held = { values, at, session };
      timer = timers.set(() => {
        timer = null;
        const waiting = held;
        held = null;
        if (waiting) dispatch(waiting);
      }, delay);
    },
    take,
    waiting: () => held !== null,
    setDispatch: (next) => {
      dispatch = next;
    },
  };
}
