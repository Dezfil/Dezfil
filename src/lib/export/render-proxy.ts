import { isIP } from "node:net";

export interface RenderProxyOptions {
  /** The app runs as the development server, whose pages open its reload
   * socket at the same host and port before they start. */
  developmentReload?: boolean;
}

/** Chromium has an implicit loopback bypass. Subtract it before admitting only
 * the app's exact origin; a different scheme, alias or port uses the relay.
 * Under the development server the same host and port is also admitted in its
 * WebSocket scheme, so the reload socket reaches the app and nothing else
 * changes: the relay still refuses every other loopback address. */
export function renderProxyFlags(appOrigin: string, relayPort: number, options: RenderProxyOptions = {}): string[] {
  const app = new URL(appOrigin);
  if (!["http:", "https:"].includes(app.protocol) || !isIP(app.hostname.replace(/^\[|\]$/g, ""))) {
    throw Error("The render app origin must have a literal address");
  }
  const port = app.port || (app.protocol === "https:" ? "443" : "80");
  const exact = `${app.protocol}//${app.hostname}:${port}`;
  // http: becomes ws: and https: becomes wss:, at the same host and port.
  const exceptions = options.developmentReload ? [exact, exact.replace(/^http/, "ws")] : [exact];
  return [
    `--proxy-server=socks5://127.0.0.1:${relayPort}`,
    `--proxy-bypass-list=<-loopback>;${exceptions.join(";")}`,
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--disable-background-networking",
  ];
}
