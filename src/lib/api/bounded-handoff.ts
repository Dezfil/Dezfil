import { boundedBodyText } from "./bounded-body";
import { LARGE_JSON_BODY_MAX_BYTES } from "./request-bounds";

declare const admittedJson: unique symbol;
/** Only the bounded handoff can construct the request an external JSON parser receives. */
export type BoundedJsonRequest = Request & { readonly [admittedJson]: true };
/** A request built with another's signal follows the caller's departure only
 * while both stay in reach: the original's signal is aborted by a controller
 * only the original holds, and the rebuilt request's own controller hears it
 * through a weakly held listener. Whoever keeps the rebuilt request, or only
 * its signal, therefore keeps both requests. */
const followed = new WeakMap<AbortSignal, readonly [Request, Request]>();
export async function boundedMcpRequest(request: Request): Promise<BoundedJsonRequest> {
  const text = await boundedBodyText(request, LARGE_JSON_BODY_MAX_BYTES, { fatal: false });
  const rebuilt = new Request(request.url, {
    method: request.method, headers: request.headers,
    ...(!["GET", "HEAD"].includes(request.method) ? { body: text } : {}), signal: request.signal,
  }) as BoundedJsonRequest;
  followed.set(rebuilt.signal, [request, rebuilt]);
  return rebuilt;
}
