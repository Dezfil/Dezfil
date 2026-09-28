import { createServer } from "node:http";
import { installIngress } from "@/lib/auth/ingress.mjs";

/** In-memory route fixtures still cross the real native dispatch sanitizer.
 * The fixture owns this loopback peer; caller forwarding cannot confer trust. */
export function socketRequest(request: Request): Request {
  installIngress();
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  headers.host = url.host;
  const incoming = {
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { remoteAddress: "127.0.0.1", encrypted: url.protocol === "https:" },
  };
  let stamped: Request | undefined;
  const server = createServer(() => { stamped = new Request(request, { headers: incoming.headers }); });
  server.emit("request", incoming);
  if (!stamped) throw new Error("Fixture socket dispatch did not reach its handler");
  return stamped;
}
