import type { ToolDef } from "@/lib/tools/tools";
import type { ImageContinuation, ModelProvider, ProviderExchange } from "../provider";

/**
 * The no-replay observer: counts what recovery must never start.
 * Assistant-originated product dispatches are every request the loop
 * sends through its fetch; provider calls are every send and
 * continuation on the provider seam. A test's own reads and writes go
 * to the routes directly, never through this fetch, so they are counted
 * apart. Resource state alone cannot show no-replay, since an identical
 * repeated update leaves the expected state and a repeated read leaves
 * no trace; these counts can.
 */

export interface Dispatch { method: string; path: string; request: Request }

export function dispatchObserver(route: (request: Request) => Promise<Response>, allowed: Set<string>) {
  const dispatches: Dispatch[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!allowed.has(url.origin)) throw new Error(`Unexpected fixture network request: ${request.url}`);
    dispatches.push({ method: request.method, path: url.pathname, request: request.clone() });
    return route(request);
  }) as typeof fetch;
  return {
    fetchImpl,
    dispatches,
    /** Mutations only: the dispatches that could change a resource. */
    mutations: () => dispatches.filter((d) => d.method !== "GET"),
    since: (count: number) => dispatches.slice(count),
  };
}

export function providerObserver(provider: ModelProvider): ModelProvider & { calls: () => number; exchanges: () => number } {
  let calls = 0; let exchanges = 0;
  return {
    id: provider.id, model: provider.model,
    // The chosen effort is the provider's own fact: a wrapper that dropped
    // it would report a default where a choice was made, and an absent one
    // stays absent rather than becoming undefined.
    ...(provider.effort !== undefined ? { effort: provider.effort } : {}),
    calls: () => calls, exchanges: () => exchanges,
    exchange(options): ProviderExchange {
      exchanges += 1;
      const inner = provider.exchange(options);
      return {
        ...(inner.setGrounding ? { setGrounding: (value: string) => inner.setGrounding!(value) } : {}),
        ...(inner.extendTools ? { extendTools: (tools: ToolDef[]) => inner.extendTools!(tools) } : {}),
        send(text, control) { calls += 1; return inner.send(text, control); },
        continueWith(outcomes, control) { calls += 1; return inner.continueWith(outcomes, control); },
        // The image continuation is a provider call like any other.
        // Offered only where the inner provider offers it, since the
        // automatic branch reads its absence as "no image path" and skips
        // itself silently.
        ...(inner.continueWithImage
          ? { continueWithImage: (continuation: ImageContinuation, control?: Parameters<NonNullable<ProviderExchange["continueWithImage"]>>[1]) => { calls += 1; return inner.continueWithImage!(continuation, control); } }
          : {}),
      };
    },
  };
}
