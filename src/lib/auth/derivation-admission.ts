import { AuthError, AuthenticationCancelled } from "./errors";

export type DerivationClass = "ordinary" | "protected";
export type DerivationOptions = { class?: DerivationClass; signal?: AbortSignal; onStart?: () => void };
type Waiting = { kind: DerivationClass; deadline: number; start: () => void; busy: () => void };
type Admission = { active: number; activeProtected: number; ordinary: Waiting[]; protected: Waiting[] };
const fresh = (): Admission => ({ active: 0, activeProtected: 0, ordinary: [], protected: [] });
const STATE = Symbol.for("dezfil.password-derivations");
const owner = process as typeof process & { [STATE]?: Admission };
const shared = owner[STATE] ??= fresh();
const busy = () => new AuthError("authentication_busy", "Authentication is busy. Try again shortly.", 503, { retryAfter: 1 });

function drain(state: Admission): void {
  for (const kind of ["ordinary", "protected"] as const) {
    for (const waiter of [...state[kind]]) if (Date.now() >= waiter.deadline) waiter.busy();
  }
  while (state.active < 2) {
    const queue = state.activeProtected === 0 && state.protected.length ? state.protected : state.ordinary;
    const next = queue.shift();
    if (!next) return;
    next.start();
  }
}

function schedule<T>(state: Admission, work: () => Promise<T>, options: DerivationOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const kind = options.class ?? "ordinary", signal = options.signal;
    if (signal?.aborted) { reject(new AuthenticationCancelled()); return; }
    drain(state);
    let started = false, timer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      const index = state[kind].indexOf(waiter);
      if (index >= 0) state[kind].splice(index, 1);
      clearTimeout(timer);
    };
    const cleanup = () => { remove(); signal?.removeEventListener("abort", abort); };
    const abort = () => {
      cleanup(); reject(new AuthenticationCancelled(started));
      // Native work cannot be cancelled. It retains its slot until settlement.
      if (!started) drain(state);
    };
    const waiter: Waiting = {
      kind, deadline: Date.now() + 5000,
      busy: () => { cleanup(); reject(busy()); },
      start: () => {
        remove(); started = true; state.active++; if (kind === "protected") state.activeProtected++;
        const finish = (error: unknown, value?: T) => {
          cleanup(); state.active--; if (kind === "protected") state.activeProtected--;
          drain(state);
          if (signal?.aborted) reject(new AuthenticationCancelled(true));
          else if (error !== undefined) reject(error);
          else resolve(value as T);
        };
        try { options.onStart?.(); work().then(value => finish(undefined, value), error => finish(error)); }
        catch (error) { finish(error); }
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (state.active < 2 && (kind === "ordinary" || state.activeProtected === 0)) waiter.start();
    else if (state[kind].length >= (kind === "ordinary" ? 6 : 2)) waiter.busy();
    else {
      state[kind].push(waiter);
      timer = setTimeout(waiter.busy, 5000);
    }
  });
}

/** Route bundles share only state; each caller owns its error and work closures. */
export function withPasswordDerivation<T>(work: () => Promise<T>, options: DerivationOptions = {}): Promise<T> {
  return schedule(shared, work, options);
}

/** Isolated admission owner for deterministic held-work tests. */
export function createDerivationAdmission() {
  const state = fresh();
  return { run: <T>(work: () => Promise<T>, options: DerivationOptions = {}) => schedule(state, work, options),
    snapshot: () => ({ active: state.active, activeProtected: state.activeProtected, ordinary: state.ordinary.length, protected: state.protected.length }) };
}
