import { boundedBodyText } from "./bounded-body";
import { LARGE_JSON_BODY_MAX_BYTES } from "./request-bounds";

declare const admittedJson: unique symbol;
/** Only the bounded handoff can construct the request an external JSON parser receives. */
export type BoundedJsonRequest = Request & { readonly [admittedJson]: true };
export async function boundedMcpRequest(request: Request): Promise<BoundedJsonRequest> {
  const text = await boundedBodyText(request, LARGE_JSON_BODY_MAX_BYTES, { fatal: false });
  return new Request(request, {
    ...(!["GET", "HEAD"].includes(request.method) ? { body: text } : {}), signal: request.signal,
  }) as BoundedJsonRequest;
}
