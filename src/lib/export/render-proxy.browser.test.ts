import { createServer } from "node:http";
import type { Socket } from "node:net";
import puppeteer from "puppeteer-core";
import { expect, it, vi } from "vitest";
import { startRenderRelay } from "./render-relay";
import { renderProxyFlags } from "./render-proxy";
import { RelaySockets } from "./relay-test-support";

// Scripted browser seam: page admission is intentionally absent so it cannot
// conceal an overly broad Chromium bypass. No certificate bypass is used.
it.skipIf(process.env.DEZFIL_RELAY_BROWSER !== "1")("the shipped browser bypasses only the exact app origin", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  const network = new RelaySockets(), appSockets = new Set<Socket>();
  let appContacts = 0;
  const app = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    response.end('<!doctype html><link rel="icon" href="data:,"><p>exact app origin</p>');
  });
  app.on("connection", socket => { appContacts++; appSockets.add(socket); socket.once("close", () => appSockets.delete(socket)); });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  const relays: Awaited<ReturnType<typeof startRenderRelay>>[] = [];
  try {
    await new Promise<void>((resolve, reject) => { app.once("error", reject); app.listen(0, "127.0.0.1", resolve); });
    const port = (app.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const other = await network.target(); await network.live(other);
    for (const target of [`https://127.0.0.1:${port}/wrong-scheme`, `http://localhost:${port}/alias`, `http://127.0.0.1:${other.port}/other-port`]) {
      const relay = await startRenderRelay({ deadline: Date.now() + 20_000, requestBoundMs: 5_000 }); relays.push(relay);
      browser = await puppeteer.launch({ executablePath: process.env.DEZFIL_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", ...renderProxyFlags(origin, relay.port)] });
      const page = await browser.newPage();
      const failed: { url: string; error: string | undefined }[] = [];
      page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
      await page.goto(origin); expect(await page.evaluate(() => document.body.textContent)).toContain("exact app origin");
      expect(appContacts).toBeGreaterThan(0); const before = appContacts;
      await page.evaluate(async url => { await fetch(url).catch(() => {}); }, target);
      expect(relay.refused, target).toBe(true);
      expect(failed).toContainEqual({ url: target, error: "net::ERR_SOCKS_CONNECTION_FAILED" });
      expect(appContacts, target).toBe(before); expect(other.contacts, target).toBe(0);
      console.info(JSON.stringify({ label: "confirmed", stimulus: "scripted page without admission", target, appContactsBefore: before, appContactsAfter: appContacts, otherContacts: other.contacts, failed }));
      relay.close(); await browser.close(); browser = undefined;
    }
  } finally {
    for (const relay of relays) relay.close();
    await browser?.close();
    for (const socket of appSockets) socket.destroy();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await network.close(); vi.unstubAllEnvs();
  }
});
