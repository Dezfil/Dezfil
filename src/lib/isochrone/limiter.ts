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
 */

export type ReleaseSlot = () => void;

interface Waiter {
  resolve: (release: ReleaseSlot) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Endpoint {
  /** When the next request may start, counting from the last one's start. */
  nextAt: number;
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
  const made: Endpoint = { nextAt: 0, busy: false, waiting: [], draining: false };
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
    const delay = Math.max(0, endpoint.nextAt - Date.now());
    const timer = setTimeout(() => {
      if (endpoint.busy) {
        // A release raced this timer; it drains again when it lands.
        endpoint.draining = false;
        return;
      }
      const next = endpoint.waiting.shift();
      if (!next) {
        endpoint.draining = false;
        return;
      }
      endpoint.busy = true;
      endpoint.nextAt = Date.now() + limits.isochronePaceMs;
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
 * only after its turn arrives.
 */
export function takeIsochroneSlot(
  key: string,
  signal?: AbortSignal,
): Promise<ReleaseSlot> {
  if (signal?.aborted) return Promise.reject(new Error("abandoned"));
  const endpoint = endpointFor(key);
  return new Promise<ReleaseSlot>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
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
