import { gateRequest } from "./gate";
import { authFailure, privateResponse } from "./http";

/** Excluded paths must gate before touching their body or resource. Carry the
 * gate's rolling cookie onto the final answer, including resource refusals. */
export async function withRouteGate(request: Request, work: () => Promise<Response>): Promise<Response> {
  const gate = gateRequest(request);
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  let response: Response;
  try { response = await work(); }
  catch (error) { response = authFailure(error); }
  privateResponse(response);
  for (const cookie of gate.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
  return response;
}

/** Only transport/refusal exports may use this: no resource callback exists. */
export async function gateOnly(request: Request): Promise<Response> {
  return withRouteGate(request, async () => { throw new Error("A resource method needs its own handler"); });
}

/** Explicit HEAD retains GET admission and headers without a response body. */
export async function gateHead(request: Request, get: (request: Request) => Promise<Response>): Promise<Response> {
  const response = await get(request);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}
