/**
 * The engine's native calls run on the runtime's worker pool, which file
 * system work, password hashing and address lookups share. A PostGIS source
 * statement blocked on the server keeps its worker until the server answers,
 * and the engine's interrupt does not reach it there. The cancellation that
 * ends such a statement needs a worker of its own, so if blocked source calls
 * held every worker, nothing could cancel them and the rest of the server
 * would wait with them. At most three quarters of the pool (at least one) may
 * therefore be out on PostGIS sources at once; further source calls wait for
 * their turn, inside their operation's lifetime.
 */

/** The largest pool the runtime starts, whatever is asked for. */
const MAX_WORKER_POOL = 1024;
/** The runtime's own default. */
const DEFAULT_WORKER_POOL = 4;

/**
 * The size of the worker pool, read as the runtime reads UV_THREADPOOL_SIZE
 * when it starts the pool: unset is 4; otherwise the leading integer, where
 * none or zero is 1 and a negative number wraps past the maximum, which caps
 * every value at 1024. The variable only counts when it is set before the
 * process starts, so it is read here and never set.
 */
export function workerPoolSize(value: string | undefined = process.env.UV_THREADPOOL_SIZE): number {
  if (value === undefined) return DEFAULT_WORKER_POOL;
  const leading = /^\s*([+-]?\d+)/.exec(value);
  const asked = leading ? Number(leading[1]) : 0;
  if (asked < 0 || asked > MAX_WORKER_POOL) return MAX_WORKER_POOL;
  return asked === 0 ? 1 : asked;
}

/** How many PostGIS source calls may be out at once on a pool of this size:
 * three quarters of it, rounded down, and at least one. From two workers up
 * this leaves at least one free. */
export function sourceCallLimit(poolSize: number = workerPoolSize()): number {
  return Math.max(1, Math.floor((poolSize * 3) / 4));
}

export interface SourceSlots {
  readonly limit: number;
  /** Resolves with the slot's release once one is free, in the order asked.
   * A signal that aborts while waiting leaves the queue without taking a
   * slot and rejects with its reason. Release is idempotent. */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Slots held and calls waiting, for observation. */
  state(): { active: number; waiting: number };
}

export function createSourceSlots(limit: number): SourceSlots {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("A slot limit must be a positive integer.");
  let active = 0;
  const waiting: (() => void)[] = [];
  const hold = (): (() => void) => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true; active -= 1;
      waiting.shift()?.();
    };
  };
  return {
    limit,
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < limit && waiting.length === 0) return Promise.resolve(hold());
      return new Promise((resolve, reject) => {
        const leave = () => {
          const at = waiting.indexOf(grant);
          if (at >= 0) waiting.splice(at, 1);
          reject(signal!.reason);
        };
        const grant = () => { signal?.removeEventListener("abort", leave); resolve(hold()); };
        waiting.push(grant);
        signal?.addEventListener("abort", leave, { once: true });
      });
    },
    state: () => ({ active, waiting: waiting.length }),
  };
}

// One pool per process, so one bound per process, whichever server bundle
// loaded this module.
const slotsKey = Symbol.for("dezfil.postgis-source-slots");
const slotsHost = process as typeof process & { [slotsKey]?: SourceSlots };

/** The process's PostGIS source call slots, sized from its worker pool. */
export function sourceSlots(): SourceSlots {
  return slotsHost[slotsKey] ??= createSourceSlots(sourceCallLimit());
}
