import { limits } from "@/lib/limits";

/**
 * One pace for the whole instance, per configured endpoint, and **one request in
 * flight at a time** (J7).
 *
 * **The provider sees an instance, not a job.** Two batches, or a batch and
 * someone typing in the search box, are one client to a rate limit — so a
 * limiter only the batch respects upholds nothing, and that is why interactive
 * place search moves onto this in the same change rather than later.
 *
 * **A slot is held, not merely granted.** Pacing alone is not what is promised:
 * a provider that takes longer to answer than the interval would have two
 * exchanges open at once, which is exactly the concurrent issuance J7 declines —
 * and it is what makes cancellation have one thing to stop and a run's duration
 * one thing to bound. So a caller holds its slot until its exchange is over and
 * releases it in a `finally`; the next slot opens at the later of *that release*
 * and *one interval after the previous request started*, which keeps the
 * provider's start-to-start rule without punishing a caller for a slow answer.
 * Found at the cross-model review, which was right that a pacing-only limiter
 * contradicts the spec's own sequential claim.
 *
 * **Interactive search takes the next slot.** A person waiting on a search box
 * is a different thing from a batch with minutes to run, so a search jumps ahead
 * of any batch that is waiting. It cannot jump ahead of a request already out —
 * nothing can — so the worst a search waits is one interval plus whatever is in
 * flight.
 *
 * Process-local, like the operation lane and the tile queue: one container is
 * the deployment, which is the promise this product makes.
 */

export type Priority = "interactive" | "batch";

/** Given up when the exchange is over. Calling it twice is harmless — a caller
 * releasing in a `finally` after an early return must not be a special case. */
export type ReleaseSlot = () => void;

interface Waiter {
  priority: Priority;
  resolve: (release: ReleaseSlot) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Endpoint {
  /** When the next request may start, counting from the last one's start. */
  nextAt: number;
  /** True while a caller holds the slot. */
  busy: boolean;
  waiting: Waiter[];
  draining: boolean;
}

const endpoints = new Map<string, Endpoint>();

/** Tests re-point the clock and the pace; nothing should survive between them. */
export function resetLimiter(): void {
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

/** How many are queued — for a test that needs a batch genuinely waiting
 * before it issues the search that must overtake it. */
export function waitingCount(key: string): number {
  return endpoints.get(key)?.waiting.length ?? 0;
}

/** Whether a caller is holding this endpoint's slot right now. */
export function inFlight(key: string): boolean {
  return endpoints.get(key)?.busy ?? false;
}

function drain(key: string): void {
  const endpoint = endpointFor(key);
  if (endpoint.draining) return;
  endpoint.draining = true;
  const step = () => {
    // Nothing may start while an exchange is out: the release re-enters here.
    if (endpoint.busy || endpoint.waiting.length === 0) {
      endpoint.draining = false;
      return;
    }
    const delay = Math.max(0, endpoint.nextAt - Date.now());
    const timer = setTimeout(() => {
      if (endpoint.busy) {
        // A release raced this timer; it will drain again when it lands.
        endpoint.draining = false;
        return;
      }
      // **Chosen at the moment the slot opens, not when it was queued.** A
      // search that arrived while the batch was waiting has to be able to take
      // this slot, which it cannot do if the order was fixed on arrival.
      const index = endpoint.waiting.findIndex(
        (w) => w.priority === "interactive",
      );
      const next = endpoint.waiting.splice(index >= 0 ? index : 0, 1)[0];
      if (!next) {
        endpoint.draining = false;
        return;
      }
      endpoint.busy = true;
      endpoint.nextAt = Date.now() + limits.geocodePaceMs;
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
 * Wait for this endpoint's next slot, and hold it.
 *
 * Resolves with the release to call when the exchange is over — in a `finally`,
 * always, because a slot nobody releases stops this endpoint for the life of the
 * process. Rejects if the caller's signal fires first, so a cancelled batch
 * stops queueing rather than stopping only after its turn arrives.
 */
export function takeSlot(
  key: string,
  priority: Priority,
  signal?: AbortSignal,
): Promise<ReleaseSlot> {
  if (signal?.aborted) return Promise.reject(new Error("abandoned"));
  const endpoint = endpointFor(key);
  return new Promise<ReleaseSlot>((resolve, reject) => {
    const waiter: Waiter = {
      priority,
      resolve,
      reject,
      ...(signal ? { signal } : {}),
    };
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
