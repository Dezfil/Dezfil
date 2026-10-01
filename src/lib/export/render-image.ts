import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { AuthError } from "@/lib/auth/errors";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { renderRequestBoundMs } from "./render-stall";
import { puppeteerDriver, type RenderBrowser, type RenderDriver } from "./render-driver";
export type { RenderBrowser, RenderDriver } from "./render-driver";
import type { ExportImageDefinition } from "./image-definition";

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

export interface RenderImageInput {
  mapId: string;
  definition: ExportImageDefinition;
  baseUrl: string;
  credential: string;
  signal?: AbortSignal;
  /** Injected by unit tests; the real driver otherwise. */
  driver?: RenderDriver;
  /** A per-call budget in milliseconds: the assistant's
   * check bounds its own wait; absent, the export's documented budget. */
  budgetMs?: number;
  /** What must still hold at every phase besides the account's activity:
   * the product's callers pass the map's reach (render-standing.ts). */
  standing?: () => void;
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
  scope: AccountScope,
  input: RenderImageInput,
): Promise<RenderImageResult> {
  // Asked again at every phase: before the queue, after the slot, after the
  // launch and after the render.
  const stand = () => { requireAccountScope(scope); input.standing?.(); };
  stand();
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
    stand();
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
      if (error instanceof ApiError || error instanceof AuthError) throw error;
      throw new ApiError(
        "render_unavailable",
        "The image renderer's browser is not available on this instance. " +
          "Check DEZFIL_CHROMIUM_PATH, or use the builder's own download.",
        503,
      );
    }
    if (input.signal?.aborted) throw new EvaluationCancelled();
    stand();
    const outcome = await awaitActiveRender(
      browser,
      {
        url: `${input.baseUrl}/render/${encodeURIComponent(input.mapId)}`,
        credential: input.credential,
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
    stand();
    settled = true;
    if (input.signal?.aborted) throw new EvaluationCancelled();
    if ("failed" in outcome) {
      // The route's own worded state — already user-safe prose; no
      // browser diagnostics ride along.
      throw new ApiError("render_failed", outcome.failed, 502);
    }
    return { png: outcome.png, abandoned: outcome.abandoned ?? [], ...(outcome.consumed ? { consumed: outcome.consumed } : {}) };
  } catch (error) {
    if (error instanceof AuthError || error instanceof ApiError || error instanceof EvaluationCancelled) {
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
