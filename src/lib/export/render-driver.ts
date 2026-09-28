import { renderRequestHeaders } from "./render-credentials";
import { admitRenderRequest } from "./render-guard";
import { stalledExternalRequests } from "./render-stall";
import { resolveMapScale, type ExportImageDefinition } from "./image-definition";

/** The minimal driver surface the renderer needs — injectable so the
 * queue, budget and lifecycle rules are unit-testable without a browser. */
export interface RenderDriver {
  launch(executablePath: string, flags: string[]): Promise<RenderBrowser>;
}

export interface RenderBrowser {
  render(input: {
    url: string;
    /** Transport-only caller credential; never delivered to page JavaScript. */
    credential: string;
    width: number;
    height: number;
    definition: ExportImageDefinition;
    deadline: number;
    /** The bound on any one request this render's page makes, resolved
     * from the call's own budget; the export road's documented bound
     * when the call set none. */
    requestBoundMs: number;
  }): Promise<
    | {
        png: Uint8Array;
        /** The hosts of requests abandoned past the per-request budget
         * one entry per request; absent or empty when none. */
        abandoned?: string[];
        /** What the render page declares it consumed, on its root once
         * ready: the state the image is attributed to, read from the
         * renderer's own inputs, never a later read. */
        consumed?: string;
      }
    | { failed: string }
  >;
  /** Close politely; the caller force-kills past the grace. */
  close(): Promise<void>;
  /** The hard stop — never allowed to fail. */
  kill(): void;
}

/** The real driver, loaded lazily so unit tests never touch it. */
export async function puppeteerDriver(): Promise<RenderDriver> {
  const puppeteer = (await import("puppeteer-core")).default;
  return {
    async launch(executablePath, flags) {
      const browser = await puppeteer.launch({
        executablePath,
        args: flags,
        headless: true,
      });
      return {
        async render({ url, width, height, definition, deadline, requestBoundMs, credential }) {
          const page = await browser.newPage();
          // The egress gate: every page request is admitted against the
          // app origin + private-range denial. A refusal is recorded
          // and takes precedence over readiness below — an aborted
          // style otherwise degrades to the offline fallback and would
          // yield a "ready" PNG that hides the refusal.
          const appOrigin = new URL(url).origin;
          const refused: string[] = [];
          let authenticationFailed = false;
          // Every admitted request in flight, with its start and host: an
          // external one that outlives the per-request budget is abandoned
          // — the page goes offline for an instant so the stalled fetch
          // fails, the map settles and the route's own readiness fires —
          // and the hosts are reported, one entry per request.
          const inflight = new Map<
            object,
            { started: number; host: string; external: boolean }
          >();
          const abandoned: string[] = [];
          // Admission verdicts still pending when the page settles: a late
          // refusal must still beat readiness, so the screenshot waits for
          // them.
          const verdicts = new Set<Promise<unknown>>();
          page.on("requestfinished", (r) => inflight.delete(r));
          page.on("requestfailed", (r) => inflight.delete(r));
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            // Timed from the moment the page made it:
            // a stalled admission counts against the request too.
            try {
              const parsed = new URL(request.url());
              if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                inflight.set(request, {
                  started: Date.now(),
                  host: parsed.hostname,
                  external: parsed.origin !== appOrigin,
                });
              }
            } catch {
              // An unparsable URL is denied below.
            }
            const verdict = admitRenderRequest(request.url(), appOrigin);
            verdicts.add(verdict);
            void verdict.finally(() => verdicts.delete(verdict));
            void verdict.then(
              (v) => {
                if (v === "allow") {
                  const headers = renderRequestHeaders(request.url(), appOrigin, credential, request.headers());
                  if (headers) return request.continue({ headers });
                  authenticationFailed = true;
                  return request.abort("blockedbyclient");
                }
                if (v === "unresolvable") {
                  // An ordinary dead hostname: fail the request with no
                  // connection and no policy claim — the page reaches
                  // its dead-style state and the image bakes that in.
                  return request.abort("namenotresolved");
                }
                refused.push(request.url());
                return request.abort("blockedbyclient");
              },
              () => {
                refused.push(request.url());
                return request.abort("blockedbyclient");
              },
            );
          });
          // The two-host coordinate contract: the route
          // renders at the composition's own CSS size and the
          // definition's map scale becomes the device scale factor —
          // same map extent, same overlay proportions, physical pixels
          // exact. That scale is the author's choice of how large the
          // map is drawn rather than an artifact of the card's preview
          // frame, and it may be below 1 (a fine map on a small image);
          // fractional factors were proven exact before the feature was
          // built on them.
          const scale = resolveMapScale(definition);
          const cssW = width / scale;
          const cssH = height / scale;
          await page.setViewport({
            width: Math.ceil(cssW),
            height: Math.ceil(cssH),
            deviceScaleFactor: scale,
          });
          // Request-scoped definition delivery — never the URL.
          await page.evaluateOnNewDocument((def: unknown) => {
            (
              window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }
            ).__DEZFIL_EXPORT_DEFINITION__ = def;
          }, definition as unknown);
          const remaining = () => Math.max(deadline - Date.now(), 1);
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: remaining(),
          });
          // The per-request bound: every request is timed on its own from
          // the moment it was made; when an external one has outlived the
          // budget and no younger external request has been in flight for
          // the grace, the stalled ones are abandoned together — the page
          // goes offline for an instant and its own stop aborts what it can
          // — each counted and said, once, at the moment. App-origin
          // requests keep the export budget as their bound: a stall on the
          // instance's own road is the coded timeout, never a cut
          // composition.
          let flipping = false;
          const mapId = decodeURIComponent(
            new URL(url).pathname.split("/").pop() ?? "",
          );
          const watchdog = setInterval(() => {
            if (flipping) return;
            const cut = stalledExternalRequests(
              inflight.entries(),
              Date.now(),
              requestBoundMs,
            );
            if (cut.length === 0) return;
            flipping = true;
            const cutHosts: string[] = [];
            for (const key of cut) {
              cutHosts.push(inflight.get(key)!.host);
              inflight.delete(key);
            }
            abandoned.push(...cutHosts);
            console.warn(
              `[export] map ${mapId}: ${cutHosts.length} request(s) abandoned past ` +
                `${Math.round(requestBoundMs / 1000)}s: ${[...new Set(cutHosts)].join(", ")}`,
            );
            void page
              .setOfflineMode(true)
              .then(() => page.setOfflineMode(false))
              .catch(() => {})
              .then(() => page.evaluate(() => window.stop()))
              .catch(() => {})
              .finally(() => {
                flipping = false;
              });
          }, 500);
          try {
            // The route declares its own settled or failed state; a
            // screenshot before either is the defect class the readiness
            // contract exists to end.
            await page.waitForFunction(
              () =>
                document.querySelector('[data-export-ready="true"]') !== null ||
                document.querySelector("[data-export-failed]") !== null,
              { timeout: remaining(), polling: 150 },
            );
          } finally {
            clearInterval(watchdog);
          }
          // A verdict still pending after readiness lands before the check
          // below, so a late refusal still beats the settled page.
          await Promise.allSettled([...verdicts]);
          const failed = await page.evaluate(() =>
            document
              .querySelector("[data-export-failed]")
              ?.getAttribute("data-export-failed"),
          );
          if (authenticationFailed) return { failed: "The render request could not be authorized. Sign in and retry." };
          if (failed) return { failed };
          if (refused.length) {
            // Coded refusal beats a settled page: the host list stays
            // server-side; the prose names the policy only.
            return {
              failed:
                "The map reaches an address this instance's egress " +
                "policy denies (private and internal ranges). The image " +
                "was not produced.",
            };
          }
          const png = (await page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: cssW, height: cssH },
          })) as Uint8Array;
          // The page's own declaration of what it drew, read after the
          // screenshot from the same settled document.
          const consumed = await page.evaluate(
            () =>
              document
                .querySelector("[data-export-root]")
                ?.getAttribute("data-export-state") ?? undefined,
          );
          return { png, abandoned, ...(consumed ? { consumed } : {}) };
        },
        async close() {
          await browser.close();
        },
        kill() {
          try {
            browser.process()?.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        },
      };
    },
  };
}
