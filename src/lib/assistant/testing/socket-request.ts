import { createServer } from "node:http";
import { installIngress } from "@/lib/auth/ingress.mjs";

/** A request built from another follows that one's signal only while the
 * one it came from is alive, so each request built here holds its source:
 * a collection must not cut the caller's departure off from the route. */
const builtFrom = new WeakMap<Request, Request>();

/** In-memory route fixtures still cross the real native dispatch sanitizer.
 * The fixture owns this loopback peer; caller forwarding cannot confer trust. */
export function socketRequest(request: Request, peer = "127.0.0.1"): Request {
  installIngress();
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  headers.host = url.host;
  const incoming = {
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { remoteAddress: peer, encrypted: url.protocol === "https:" },
  };
  let stamped: Request | undefined;
  const server = createServer(() => { stamped = new Request(request, { headers: incoming.headers }); });
  server.emit("request", incoming);
  if (!stamped) throw new Error("Fixture socket dispatch did not reach its handler");
  builtFrom.set(stamped, request);
  return stamped;
}
