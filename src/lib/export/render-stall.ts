import { limits } from "@/lib/limits";

/**
 * The per-request bound and the abandonment decision, out of the lazily
 * loaded browser driver so both are readable and testable on their own.
 */

/** How long after the youngest external request the decision waits, so a
 * burst that is still arriving is not cut mid-flight. */
export const STALL_GRACE_MS = 2_000;

/**
 * The bound on any one request the render page makes, for this call.
 *
 * The export road's documented bound is built for the export's own 90 s
 * budget, and leaves plenty after an abandonment for the page to settle,
 * reach readiness and be photographed. A call that bounds its own wait
 * instead (the assistant's map check, 30 s by default) has that whole
 * sequence to fit inside its budget, and at the export's bound it had no
 * room left: a slow tile host cost the check outright. A third of the
 * call's budget leaves twice the bound for the grace, the flip, the
 * settle and the screenshot. With no per-call budget the export road's
 * own bound stands, unchanged.
 */
export function renderRequestBoundMs(budgetMs?: number): number {
  const documented = limits.exportRequestTimeoutMs;
  if (budgetMs === undefined) return documented;
  return Math.max(1, Math.min(documented, Math.floor(budgetMs / 3)));
}

export interface InflightRequest {
  /** When the page made the request. */
  started: number;
  host: string;
  external: boolean;
}

function requestKey(request: object): object | string {
  // Puppeteer marks HTTPRequest.id internal in its public types. It is the
  // network id shared by repeated pauses of one request, which can produce
  // distinct objects but only one finish. If absent, retain object identity:
  // unrelated requests must never be merged by URL or an undefined key.
  const id = (request as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : request;
}

/** Bookkeeping shared by request events and the stall watchdog. */
export class RenderRequestLedger {
  private readonly requests = new Map<object | string, InflightRequest>();

  start(request: object, metadata: InflightRequest): void {
    const key = requestKey(request);
    if (!this.requests.has(key)) this.requests.set(key, metadata);
  }

  finish(request: object): void {
    this.requests.delete(requestKey(request));
  }

  abandon(now: number, boundMs: number): string[] {
    return stalledExternalRequests(this.requests.entries(), now, boundMs).map((key) => {
      const host = this.requests.get(key)!.host;
      this.requests.delete(key);
      return host;
    });
  }
}

/**
 * Which requests are abandoned at this moment: every external one, when
 * one of them has outlived the bound, none of them is younger than the
 * grace, and no app-origin request is still in flight. A stall on the
 * instance's own road is the coded timeout, never a cut composition, so
 * an app-origin request in flight holds the decision off entirely. The
 * external ones go together because the page is taken offline for an
 * instant to end them.
 */
export function stalledExternalRequests<K>(
  inflight: Iterable<[K, InflightRequest]>,
  now: number,
  boundMs: number,
  graceMs: number = STALL_GRACE_MS,
): K[] {
  const entries = [...inflight];
  if (entries.some(([, m]) => !m.external)) return [];
  const external = entries.filter(([, m]) => m.external);
  if (!external.some(([, m]) => now - m.started > boundMs)) return [];
  if (external.some(([, m]) => now - m.started < graceMs)) return [];
  return external.map(([key]) => key);
}
