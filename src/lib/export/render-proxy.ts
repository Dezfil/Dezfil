import { isIP } from "node:net";

/** Chromium has an implicit loopback bypass. Subtract it before admitting only
 * the app's exact origin; a different scheme, alias or port uses the relay. */
export function renderProxyFlags(appOrigin: string, relayPort: number): string[] {
  const app = new URL(appOrigin);
  if (!["http:", "https:"].includes(app.protocol) || !isIP(app.hostname.replace(/^\[|\]$/g, ""))) {
    throw Error("The render app origin must have a literal address");
  }
  const port = app.port || (app.protocol === "https:" ? "443" : "80");
  return [
    `--proxy-server=socks5://127.0.0.1:${relayPort}`,
    `--proxy-bypass-list=<-loopback>;${app.protocol}//${app.hostname}:${port}`,
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--disable-background-networking",
  ];
}
