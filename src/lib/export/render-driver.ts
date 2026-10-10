import type { ChildProcess } from "node:child_process";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { startRenderRelay, type RenderRelay } from "./render-relay";
import { renderProxyFlags } from "./render-proxy";
import { renderRequestHeaders } from "./render-credentials";
import { admitRenderRequest } from "./render-guard";
import { stalledExternalRequests } from "./render-stall";
import { resolveMapScale, type ExportImageDefinition } from "./image-definition";

/** The minimal driver surface the renderer needs — injectable so the
 * queue, budget and lifecycle rules are unit-testable without a browser. */
export interface RenderDriver {
  launch(executablePath: string, flags: string[], context: RenderLaunchContext): Promise<RenderBrowser>;
}

export interface RenderLaunchContext {
  appOrigin: string;
  deadline: number;
  requestBoundMs: number;
  signal?: AbortSignal;
  /** How long the browser's start may take when the caller holds it to its
   * own time; absent, the driver's own launch timeout, as for an export. */
  launchTimeoutMs?: number;
  /** The caller's hard stop: aborted, it ends the browser's process by its
   * own handle, while it is still starting too. */
  stop?: AbortSignal;
}

/** How long a browser ended outright is waited for. A killed process
 * cannot refuse to end, so only one the system never reaps outlasts it. */
export const BROWSER_EXIT_BOUND_MS = 1_000;

const EGRESS_REFUSAL = "The map reaches an address this instance's egress " +
  "policy denies (private and internal ranges). The image was not produced.";

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
  /** The hard stop, never allowed to fail: it settles once the browser's
   * process has exited, or past `BROWSER_EXIT_BOUND_MS` for one the system
   * never reaps. A stand-in with no process of its own may end at once. */
  kill(): void | Promise<void>;
}

/** End `child` outright, settling once it has exited or past the bound. */
function endProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(bound); child.off("exit", done); resolve(); };
    const bound = setTimeout(done, BROWSER_EXIT_BOUND_MS);
    child.once("exit", done);
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone: its exit is on its way.
    }
  });
}

/** The real driver, loaded lazily so unit tests never touch it. */
export async function puppeteerDriver(): Promise<RenderDriver> {
  const puppeteer = (await import("puppeteer-core")).default;
  return {
    async launch(executablePath, flags, context) {
      let relay: RenderRelay;
      try {
        relay = await startRenderRelay(context);
      } catch {
        if (context.signal?.aborted) throw new EvaluationCancelled();
        throw new ApiError("render_failed", "The image could not be rendered. Retry; if it persists, the " +
          "instance's renderer needs attention.", 502);
      }
      let browser;
      try {
        if (context.signal?.aborted) throw new EvaluationCancelled();
        browser = await puppeteer.launch({
          executablePath,
          args: [...flags, ...renderProxyFlags(context.appOrigin, relay.port)],
          headless: true,
          // A launch held to its caller's time gives up within it, and the
          // caller's stop kills the process (its group, by its own id)
          // even before it has answered. An export's keeps the defaults.
          ...(context.launchTimeoutMs !== undefined ? { timeout: context.launchTimeoutMs } : {}),
          ...(context.stop ? { signal: context.stop } : {}),
        });
      } catch (error) {
        relay.close();
        throw error;
      }
      const refused: string[] = [];
      const render: RenderBrowser["render"] = async ({ url, width, height, definition, deadline, requestBoundMs, credential }) => {
        const page = await browser.newPage();
        // The egress gate: every page request is admitted against the
        // app origin + private-range denial. A refusal is recorded
        // and takes precedence over readiness below — an aborted
        // style otherwise degrades to the offline fallback and would
        // yield a "ready" PNG that hides the refusal.
        const appOrigin = new URL(url).origin;
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
        await relay.settleAdmissions();
        const failed = await page.evaluate(() =>
          document
            .querySelector("[data-export-failed]")
            ?.getAttribute("data-export-failed"),
        );
        if (authenticationFailed) return { failed: "The render request could not be authorized. Sign in and retry." };
        if (refused.length || relay.refused) return { failed: EGRESS_REFUSAL };
        if (failed) return { failed };
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
      };
      return {
        async render(input) {
          try {
            const outcome = await render(input);
            await relay.settleAdmissions();
            // Capture and its metadata read can race a connection verdict.
            if (refused.length || relay.refused) return { failed: EGRESS_REFUSAL };
            return outcome;
          } catch (error) {
            if (refused.length || relay.refused) return { failed: EGRESS_REFUSAL };
            throw error;
          }
        },
        async close() {
          relay.close();
          await browser.close();
        },
        kill() {
          relay.close();
          return endProcess(browser.process());
        },
      };
    },
  };
}
