import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { relayRefusedEgress } from "@/lib/basemap-satellite-tiles";
import { startRenderRelay, type RenderRelay } from "./render-relay";
import { renderProxyFlags } from "./render-proxy";
import { renderRequestHeaders } from "./render-credentials";
import { admitRenderRequest } from "./render-guard";
import { RenderRequestLedger } from "./render-stall";
import { settleRenderTiles } from "./render-settle";
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
  /** Told, before a failed launch rejects, how the process it started
   * ends: settled once that process has exited, or past
   * `BROWSER_EXIT_BOUND_MS` for one the system never reaps. */
  exited?: (gone: Promise<void>) => void;
}

/** How long a browser ended outright is waited for. A killed process
 * cannot refuse to end, so only one the system never reaps outlasts it. */
export const BROWSER_EXIT_BOUND_MS = 1_000;

/** Why an image whose map reaches an address the egress policy refuses
 * was not made. */
export const EGRESS_REFUSAL = "The map reaches an address this instance's egress " +
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
        /** One host entry per abandonment. A request can be cut repeatedly
         * if no terminal event arrives; absent or empty when none. */
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

/** Names one launch's browser on its command line, with a value no other
 * launch has. Chromium keeps a switch it has no use for and does nothing
 * with it. */
const LAUNCH_SWITCH = "--dezfil-render-launch";

/** Watches the processes this server starts for the one a launch starts,
 * the one whose command line carries `token`, and keeps only it. The
 * watching ends at that process, at `end()`, or as soon as one of `stops`
 * aborts: a launch that never starts its browser nor answers watches no
 * longer than its caller waits for it. */
function watchStart(token: string, stops: (AbortSignal | undefined)[]): { started: () => ChildProcess | null; end: () => void } {
  let found: ChildProcess | null = null;
  let watching = true;
  function end() {
    if (!watching) return;
    watching = false;
    unsubscribe("child_process", onStart);
    for (const stop of stops) stop?.removeEventListener("abort", end);
  }
  function onStart(message: unknown) {
    const child = (message as { process?: ChildProcess }).process;
    // Told as the process is made, before its arguments are set; they are
    // read once the spawn that made it has returned.
    if (child) queueMicrotask(() => {
      if (!found && child.spawnargs?.includes(token)) {
        found = child;
        end();
      }
    });
  }
  subscribe("child_process", onStart);
  for (const stop of stops) stop?.addEventListener("abort", end, { once: true });
  if (stops.some((stop) => stop?.aborted)) end();
  return { started: () => found, end };
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
      const token = `${LAUNCH_SWITCH}=${randomUUID()}`;
      const args = [...flags, ...renderProxyFlags(context.appOrigin, relay.port), token];
      const start = watchStart(token, [context.stop, context.signal]);
      try {
        if (context.signal?.aborted) throw new EvaluationCancelled();
        browser = await puppeteer.launch({
          executablePath,
          args,
          headless: true,
          // A launch held to its caller's time gives up within it, and the
          // caller's stop kills the process (its group, by its own id)
          // even before it has answered. An export's keeps the defaults.
          ...(context.launchTimeoutMs !== undefined ? { timeout: context.launchTimeoutMs } : {}),
          ...(context.stop ? { signal: context.stop } : {}),
        });
      } catch (error) {
        relay.close();
        // A launch that gives up (its own timeout, a lost connection) answers
        // before the process it started has gone: puppeteer closes that
        // process afterwards, without waiting. It is ended outright here, and
        // the caller is told when it has exited.
        context.exited?.(endProcess(start.started()));
        throw error;
      } finally {
        start.end();
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
        // by ending the relay's sockets, including worker fetches. The
        // page is told at every cut to settle tiles that never reached a socket,
        // and the hosts are reported, one entry per abandonment. Requests
        // without a terminal event stay armed for another cut.
        const inflight = new RenderRequestLedger();
        const abandoned: string[] = [];
        // Admission verdicts still pending when the page settles: a late
        // refusal must still beat readiness, so the screenshot waits for
        // them.
        const verdicts = new Set<Promise<unknown>>();
        page.on("requestfinished", (r) => inflight.finish(r));
        page.on("requestfailed", (r) => inflight.finish(r));
        // The instance's satellite tiles are fetched by the instance, which
        // the gate admits as the app's: a refusal by the outbound policy
        // there, at the imagery's host or at a redirect, reaches the page
        // as a tile that failed. The relay marks that refusal, and its mark
        // on the instance's own answer is taken as a refused request.
        page.on("response", (response) => {
          if (relayRefusedEgress({ url: response.url(), status: response.status(), headers: response.headers() }, appOrigin)) {
            refused.push(response.url());
          }
        });
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          // Timed from the moment the page made it:
          // a stalled admission counts against the request too.
          try {
            const parsed = new URL(request.url());
            if (parsed.protocol === "http:" || parsed.protocol === "https:") {
              inflight.start(request, {
                started: Date.now(),
                host: parsed.hostname.replace(/^\[|\]$/g, ""),
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
        // the grace, every external request in flight has its socket ended
        // through the relay, including worker fetches. Only hosts of requests
        // that outlived the bound since their start or last abandonment are
        // remembered and refused for this render; younger hosts can re-dial.
        // Requests without a terminal event stay armed and trigger another
        // cut after another bound.
        // The page's offline flip and stop remain for main-thread requests.
        // Each abandonment is counted and logged. App-origin
        // requests keep the export budget as their bound: a stall on the
        // instance's own road is the coded timeout, never a cut
        // composition.
        let flipping = false;
        const mapId = decodeURIComponent(
          new URL(url).pathname.split("/").pop() ?? "",
        );
        const watchdog = setInterval(() => {
          if (flipping) return;
          const { cutHosts, stalledHosts } = inflight.abandon(Date.now(), requestBoundMs);
          if (cutHosts.length === 0) return;
          flipping = true;
          abandoned.push(...cutHosts);
          console.warn(
            `[export] map ${mapId}: ${cutHosts.length} request(s) abandoned past ` +
              `${Math.round(requestBoundMs / 1000)}s: ${[...new Set(cutHosts)].join(", ")}`,
          );
          relay.abandon(stalledHosts);
          void page.evaluate(settleRenderTiles).catch(() => {});
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
