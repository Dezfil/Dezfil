import { ApiError } from "@/lib/api/errors";
import { requireIngress } from "@/lib/auth/ingress.mjs";
import { accountingSource } from "@/lib/auth/source-group";
import { rateLimit, tileMaxPerWindow } from "./rate-limit";

/** Verify source before reading a body or resolving even an unknown token.
 * The budget is charged to the source's accounting identity: an IPv6 source
 * shares one budget with its /64. */
export function admitPublishedRequest(request: Pick<Request, "headers">, bucket: "pub" | "tile" = "pub"): void {
  let source: string;
  try { source = requireIngress(request.headers).source; }
  catch { throw new ApiError("ingress_unavailable", "The instance cannot serve published maps yet.", 503); }
  if (!rateLimit(`${bucket}:${accountingSource(source)}`, Date.now(), bucket === "tile" ? tileMaxPerWindow() : undefined)) {
    throw new ApiError("rate_limited", "Too many requests. Please slow down.", 429);
  }
}
