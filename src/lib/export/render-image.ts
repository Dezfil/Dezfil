import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { admitRenderRequest } from "./render-guard";
import { renderRequestBoundMs, stalledExternalRequests } from "./render-stall";
import {
  resolveMapScale,
  type ExportImageDefinition,
} from "./image-definition";

/**
 * The server image renderer: drive a headless browser at the bare render
 * route and screenshot the settled composition. Bounded and honest — a
 * documented budget spans queue wait through response, a documented
 * concurrency cap holds software-GL pressure, and caller departure,
 * timeout, and crash each kill the browser process and release the slot.
 * Every failure is a documented coded error; health is never touched.
 *
 * The flag posture, stated: the runbook's five software-GL flags
 * (SwiftShader — proven offline in the image by the spike), plus
 * `--no-sandbox` (the container runs rootless without the user
 * namespaces chromium's sandbox wants; the only pages rendered are the
 * app's own origin) and `--disable-dev-shm-usage` (default /dev/shm is
 * too small for a compositor).
 */

const CHROMIUM_FLAGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--disable-gpu-sandbox",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
];

/** How long a closing browser gets before it is killed outright. */
const CLOSE_GRACE_MS = 3_000;

/** The minimal driver surface the renderer needs — injectable so the
 * queue, budget and lifecycle rules are unit-testable without a browser. */
export interface RenderDriver {
  launch(executablePath: string, flags: string[]): Promise<RenderBrowser>;
}

export interface RenderBrowser {
  render(input: {
    url: string;
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

function chromiumPath(): string {
  return process.env.DEZFIL_CHROMIUM_PATH ?? "/usr/bin/chromium";
}

// ---- the slot queue (documented cap; budget covers the wait) ----

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
}

let active = 0;
let launches = 0;
const waiters: Waiter[] = [];

function releaseSlot(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) {
    active += 1;
    next.resolve();
  }
}

function acquireSlot(deadline: number, signal?: AbortSignal, budgetMs?: number): Promise<void> {
  if (active < limits.exportRenderConcurrency) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve: () => {}, reject };
    const timer = setTimeout(
      () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(renderTimeout(budgetMs));
      },
      Math.max(deadline - Date.now(), 1),
    );
    const onAbort = () => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      clearTimeout(timer);
      reject(new EvaluationCancelled());
    };
    waiter.resolve = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    waiters.push(waiter);
  });
}

function renderTimeout(budgetMs?: number): ApiError {
  // A per-call budget (the assistant's check) names itself; the export's
  // own budget keeps its remedy.
  if (budgetMs !== undefined) {
    const seconds = budgetMs / 1000;
    return new ApiError(
      "render_timeout",
      `The image render exceeded the ${Number.isInteger(seconds) ? seconds : seconds.toFixed(2)} s check budget (queue wait included).`,
      408,
    );
  }
  return new ApiError(
    "render_timeout",
    `The image render exceeded the ${Math.round(
      limits.exportRenderTimeoutMs / 1000,
    )}s export budget (queue wait included). Retry, reduce the size, or raise DEZFIL_EXPORT_RENDER_TIMEOUT_S.`,
    408,
  );
}

/**
 * Await an active render without making renderer cooperation part of the
 * request boundary. The handlers remain attached after timeout/cancellation,
 * so a late driver resolution or rejection is observed but cannot replace the
 * result already returned to the caller.
 */
function awaitActiveRender(
  browser: RenderBrowser,
  input: Parameters<RenderBrowser["render"]>[0],
  deadline: number,
  signal?: AbortSignal,
  budgetMs?: number,
): Promise<Awaited<ReturnType<RenderBrowser["render"]>>> {
  const rendering = browser.render(input);

  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;

    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      settle();
    };

    const terminate = (error: unknown) => {
      if (finished) return;
      browser.kill();
      finish(() => reject(error));
    };

    onAbort = () => terminate(new EvaluationCancelled());
    timer = setTimeout(
      () => terminate(renderTimeout(budgetMs)),
      Math.max(deadline - Date.now(), 1),
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    // This is also the late-outcome observer. Both callbacks return normally
    // after a boundary result, so a losing rejection cannot go unhandled.
    void rendering.then(
      (outcome) => finish(() => resolve(outcome)),
      (error) => finish(() => reject(error)),
    );

    if (signal?.aborted) onAbort();
  });
}

/** The real driver, loaded lazily so unit tests never touch it. */
async function puppeteerDriver(): Promise<RenderDriver> {
  const puppeteer = (await import("puppeteer-core")).default;
  return {
    async launch(executablePath, flags) {
      const browser = await puppeteer.launch({
        executablePath,
        args: flags,
        headless: true,
      });
      return {
        async render({ url, width, height, definition, deadline, requestBoundMs }) {
          const page = await browser.newPage();
          // The egress gate: every page request is admitted against the
          // app origin + private-range denial. A refusal is recorded
          // and takes precedence over readiness below — an aborted
          // style otherwise degrades to the offline fallback and would
          // yield a "ready" PNG that hides the refusal.
          const appOrigin = new URL(url).origin;
          const refused: string[] = [];
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
                if (v === "allow") return request.continue();
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

export interface RenderImageInput {
  mapId: string;
  definition: ExportImageDefinition;
  baseUrl: string;
  signal?: AbortSignal;
  /** Injected by unit tests; the real driver otherwise. */
  driver?: RenderDriver;
  /** A per-call budget in milliseconds: the assistant's
   * check bounds its own wait; absent, the export's documented budget. */
  budgetMs?: number;
}

export interface RenderImageResult {
  png: Uint8Array;
  /** The hosts of requests abandoned past the per-request budget (spec
   * one entry per request; empty when every request answered. */
  abandoned: string[];
  /** The render page's declaration of what it consumed, when it made one. */
  consumed?: string;
}

/** Render one map to PNG under the documented bounds. */
export async function renderMapImage(
  input: RenderImageInput,
): Promise<RenderImageResult> {
  const budgetMs = input.budgetMs;
  const deadline = Date.now() + (budgetMs ?? limits.exportRenderTimeoutMs);
  await acquireSlot(deadline, input.signal, budgetMs);
  let browser: RenderBrowser | null = null;
  let settled = false;
  let timedOut = false;
  const watchdog = setTimeout(
    () => {
      // The hard stop: a render past its budget dies, it never lingers — and the outcome is
      // deterministically the coded timeout (a watchdog expiry must never read as render_failed).
      timedOut = true;
      browser?.kill();
    },
    Math.max(deadline - Date.now(), 1),
  );
  try {
    const driver = input.driver ?? (await puppeteerDriver());
    try {
      // Launch is inside the budget too: a stalled
      // launch races the remaining deadline; a late arrival is closed.
      launches += 1;
      const launching = driver.launch(chromiumPath(), CHROMIUM_FLAGS);
      launching.catch(() => {});
      browser = await new Promise<RenderBrowser>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            timedOut = true;
            reject(renderTimeout(budgetMs));
          },
          Math.max(deadline - Date.now(), 1),
        );
        // The caller's departure aborts a slow launch too: the slot must
        // not sit held behind a stuck startup.
        const onAbort = () => reject(new EvaluationCancelled());
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) onAbort();
        launching.then(resolve, reject).finally(() => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
        });
      }).catch((error: unknown) => {
        launching.then((late) => late.kill()).catch(() => {});
        throw error;
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "render_unavailable",
        "The image renderer's browser is not available on this instance. " +
          "Check DEZFIL_CHROMIUM_PATH, or use the builder's own download.",
        503,
      );
    }
    if (input.signal?.aborted) throw new EvaluationCancelled();
    const outcome = await awaitActiveRender(
      browser,
      {
        url: `${input.baseUrl}/render/${encodeURIComponent(input.mapId)}`,
        width: input.definition.size.width,
        height: input.definition.size.height,
        definition: input.definition,
        deadline,
        requestBoundMs: renderRequestBoundMs(budgetMs),
      },
      deadline,
      input.signal,
      budgetMs,
    );
    settled = true;
    if (input.signal?.aborted) throw new EvaluationCancelled();
    if ("failed" in outcome) {
      // The route's own worded state — already user-safe prose; no
      // browser diagnostics ride along.
      throw new ApiError("render_failed", outcome.failed, 502);
    }
    return { png: outcome.png, abandoned: outcome.abandoned ?? [], ...(outcome.consumed ? { consumed: outcome.consumed } : {}) };
  } catch (error) {
    if (error instanceof ApiError || error instanceof EvaluationCancelled) {
      throw error;
    }
    if (input.signal?.aborted) throw new EvaluationCancelled();
    if (timedOut || (!settled && Date.now() >= deadline)) {
      throw renderTimeout(budgetMs);
    }
    throw new ApiError(
      "render_failed",
      "The image could not be rendered. Retry; if it persists, the " +
        "instance's renderer needs attention.",
      502,
    );
  } finally {
    clearTimeout(watchdog);
    if (browser) {
      const closing = browser.close();
      const killTimer = setTimeout(() => browser?.kill(), CLOSE_GRACE_MS);
      void closing
        .catch(() => browser?.kill())
        .finally(() => clearTimeout(killTimer));
    }
    releaseSlot();
  }
}

/** Test seam: the current queue depth (unit assertions only). */
export function renderQueueState(): { active: number; waiting: number } {
  return { active, waiting: waiters.length };
}

/** Test and measurement seam: physical launch attempts since the process
 * started, a failed one too (renders counted at the renderer, never
 * from successful results). */
export function renderStats(): { launches: number } {
  return { launches };
}
