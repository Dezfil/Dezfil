/**
 * Where this instance reaches its own HTTP API. Dezfil is one container on
 * one port, so loopback is always right; prefer the environment-named port,
 * then the incoming request's port, then the dev default.
 */
export function selfBaseUrl(request?: Request): string {
  if (process.env.PORT) return `http://127.0.0.1:${process.env.PORT}`;
  if (request) {
    const port = new URL(request.url).port;
    if (port) return `http://127.0.0.1:${port}`;
  }
  return "http://127.0.0.1:3000";
}
