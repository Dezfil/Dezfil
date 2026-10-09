import { limits } from "@/lib/limits";

/**
 * The isochrone endpoint's own pace: one exchange in flight per configured
 * endpoint, the next slot opening at the later of the previous release and
 * one interval after the previous start.
 *
 * **The geocoder's limiter shape, deliberately not its code or its map**
 * (K4): a shared limiter throttles each provider by the other's limit, and
 * the rule's second half — a geocoding run in flight neither delays nor
 * is delayed by an isochrone run — is true here structurally, because the
 * two limiters do not share state. What this copy also drops is the
 * interactive priority lane: no search box asks for an isochrone, so every
 * caller is a batch and arrival order is the queue.
 *
 * A slot is **held, not merely granted** — a provider slower than the
 * interval would otherwise have two exchanges open at once, which is the
 * concurrent issuance the spec declines. Release in a `finally`, always;
 * releasing twice is harmless by construction.
 *
 * **Each request waits by its own gap**: a run's, as it was admitted, so a
 * gap changed while a run works applies to runs admitted after it.
 */

export type ReleaseSlot = () => void;

interface Waiter {
  /** How long after the previous request's start this one may start. */
  gapMs: number;
  resolve: (release: ReleaseSlot) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Endpoint {
  /** When the previous request started; each waiter keeps its own gap after it. */
  lastStartAt: number;
  busy: boolean;
  waiting: Waiter[];
  draining: boolean;
}

const endpoints = new Map<string, Endpoint>();

/** Tests re-point the clock and the pace; nothing survives between them. */
export function resetIsochroneLimiter(): void {
  for (const endpoint of endpoints.values()) {
    for (const waiter of endpoint.waiting) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    }
  }
  endpoints.clear();
}

function endpointFor(key: string): Endpoint {
  const found = endpoints.get(key);
  if (found) return found;
  const made: Endpoint = { lastStartAt: Number.NEGATIVE_INFINITY, busy: false, waiting: [], draining: false };
  endpoints.set(key, made);
  return made;
}

/** Whether a caller is holding this endpoint's slot right now — criterion
 * 10's in-flight maximum is measured with this, not with start times. */
export function isochroneInFlight(key: string): boolean {
  return endpoints.get(key)?.busy ?? false;
}

function drain(key: string): void {
  const endpoint = endpointFor(key);
  if (endpoint.draining) return;
  endpoint.draining = true;
  const step = () => {
    if (endpoint.busy || endpoint.waiting.length === 0) {
      endpoint.draining = false;
      return;
    }
    const delay = Math.max(0, endpoint.lastStartAt + endpoint.waiting[0].gapMs - Date.now());
    const timer = setTimeout(() => {
      if (endpoint.busy) {
        // A release raced this timer; it drains again when it lands.
        endpoint.draining = false;
        return;
      }
      const next = endpoint.waiting[0];
      if (!next) {
        endpoint.draining = false;
        return;
      }
      // A waiter that left the queue may have been the one the timer was
      // set for: the next waits out its own gap.
      if (Date.now() < endpoint.lastStartAt + next.gapMs) {
        step();
        return;
      }
      endpoint.waiting.shift();
      endpoint.busy = true;
      endpoint.lastStartAt = Date.now();
      next.signal?.removeEventListener("abort", next.onAbort!);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        endpoint.busy = false;
        drain(key);
      });
      endpoint.draining = false;
    }, delay);
    timer.unref?.();
  };
  step();
}

/**
 * Wait for this endpoint's next slot, and hold it. Rejects if the caller's
 * signal fires first, so a cancelled run stops queueing rather than stopping
 * only after its turn arrives. `gapMs` is the gap this request keeps after
 * the previous start: its run's, as admitted; absent, the one in effect now.
 */
export function takeIsochroneSlot(
  key: string,
  signal?: AbortSignal,
  gapMs: number = limits.isochronePaceMs,
): Promise<ReleaseSlot> {
  if (signal?.aborted) return Promise.reject(new Error("abandoned"));
  const endpoint = endpointFor(key);
  return new Promise<ReleaseSlot>((resolve, reject) => {
    const waiter: Waiter = { gapMs, resolve, reject, ...(signal ? { signal } : {}) };
    waiter.onAbort = () => {
      const at = endpoint.waiting.indexOf(waiter);
      if (at >= 0) endpoint.waiting.splice(at, 1);
      reject(new Error("abandoned"));
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    endpoint.waiting.push(waiter);
    drain(key);
  });
}
