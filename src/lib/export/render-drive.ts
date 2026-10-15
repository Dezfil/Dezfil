import { settingRemedy } from "@/lib/settings/remedy";
import { trackRenderWork } from "./render-work";
import { AuthError } from "@/lib/auth/errors";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { BROWSER_EXIT_BOUND_MS, puppeteerDriver, type RenderBrowser, type RenderDriver } from "./render-driver";
import type { ExportImageDefinition } from "./image-definition";

/**
 * One drive of the headless browser, from a held image slot to the
 * screenshot: launch under the deadline through the driver (its relay and
 * its egress guard), drive to one page of the app's own origin with the
 * render credential, wait for the page's own readiness, photograph, then
 * close the browser, killing it past a grace. A render past its deadline
 * is killed, never left running. The export of a map and the image
 * renderer's Test both drive through here; the slot is the caller's,
 * taken before and released once this settles, which is only once the
 * browser has closed, or been ended outright and its process has exited
 * (or, for a caller that answers first, once the end it was handed has
 * settled), so no browser outlives its slot.
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

/** How long a closing browser gets before it is killed outright, at most:
 * never past the drive's deadline. */
const CLOSE_GRACE_MS = 3_000;

/** Close the browser politely, ending it outright by `end` when the close
 * fails or has not finished within `graceMs`; settles once it has closed or
 * its process has exited. */
async function endBrowser(browser: RenderBrowser, graceMs: number, accountId: string, end: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); });
  try {
    const closed = trackRenderWork(accountId, browser.close()).then(() => true, () => false);
    if (!(await Promise.race([closed, grace]))) await end();
  } catch {
    await end();
  } finally {
    clearTimeout(timer);
  }
}

/** `work`, or nothing more once `ms` have passed. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work.then(() => {}, () => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

/** The browser to launch, as configured now. */
export function chromiumPath(): string {
  return process.env.DEZFIL_CHROMIUM_PATH ?? "/usr/bin/chromium";
}

let launches = 0;
/** Physical launch attempts since the process started, a failed one too. */
export function driveLaunches(): number {
  return launches;
}

/** The time a render may take from its request, and whether it is a
 * per-call budget (a check's) rather than the export's own. */
export interface RenderBudget { timeoutMs: number; check: boolean; }

export function renderTimeout(budget: RenderBudget): ApiError {
  // A per-call budget (the assistant's check) names itself; the export's
  // own budget keeps its remedy.
  if (budget.check) {
    const seconds = budget.timeoutMs / 1000;
    return new ApiError(
      "render_timeout",
      `The image render exceeded the ${Number.isInteger(seconds) ? seconds : seconds.toFixed(2)} s check budget (queue wait included).`,
      408,
    );
  }
  return new ApiError(
    "render_timeout",
    `The image render exceeded the ${Math.round(
      budget.timeoutMs / 1000,
    )}s export budget (queue wait included). Retry or reduce the size. ${settingRemedy("exportRenderTimeoutS")}`,
    408,
  );
}

export interface RenderImageResult {
  png: Uint8Array;
  /** One host entry per abandonment, including repeated cuts of a request
   * with no terminal event; empty when every request answered. */
  abandoned: string[];
  /** The render page's declaration of what it consumed, when it made one. */
  consumed?: string;
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
  signal: AbortSignal | undefined,
  budget: RenderBudget,
  accountId: string,
  end: () => Promise<void>,
): Promise<Awaited<ReturnType<RenderBrowser["render"]>>> {
  const rendering = trackRenderWork(accountId, browser.render(input));

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
      void end();
      finish(() => reject(error));
    };

    onAbort = () => terminate(new EvaluationCancelled());
    timer = setTimeout(
      () => terminate(renderTimeout(budget)),
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

export interface RenderDrive {
  /** The page to photograph, on the app's own origin. */
  url: string;
  /** Transport-only caller credential; never delivered to page JavaScript. */
  credential: string;
  definition: ExportImageDefinition;
  deadline: number;
  /** The bound on any one request the page makes. */
  requestBoundMs: number;
  budget: RenderBudget;
  signal?: AbortSignal;
  /** Injected by unit tests; the real driver otherwise. */
  driver?: RenderDriver;
  /** The account the browser's work is tracked against. */
  accountId: string;
  /** What must still hold, asked after the slot, the launch and the render. */
  stand: () => void;
  /** Where the drive answers before a launch it gave up on has ended (its
   * deadline or its caller's departure came first), the bounded end of that
   * launch is handed here and the caller keeps its slot until it settles:
   * an export answers at its budget and its browser still never outlives
   * the slot. Absent, the drive itself waits for that end before it
   * settles (the renderer's Test). */
  hold?: (end: Promise<void>) => void;
}

/** Drive the browser for one image, on a slot the caller holds. Throws the
 * documented outcomes (render_timeout, render_unavailable, render_failed)
 * or the cancellation. */
export async function driveRender(drive: RenderDrive): Promise<RenderImageResult> {
  const { budget, deadline, requestBoundMs } = drive;
  let browser: RenderBrowser | null = null;
  let settled = false;
  let timedOut = false;
  // The browser ended outright, once: settled when its process has exited.
  let ended: Promise<void> | null = null;
  const endOutright = (target: RenderBrowser): Promise<void> => {
    if (!ended) {
      let killing: void | Promise<void>;
      try { killing = target.kill(); } catch { killing = undefined; }
      ended = Promise.resolve(killing).then(() => {}, () => {});
    }
    return ended;
  };
  // A late arrival of a launch given up on, ended outright once it arrives.
  let lateEnd: Promise<void> | null = null;
  // A launch that failed: settled once the process it started has exited,
  // within the bound, as its driver reports it.
  let launchExit: Promise<void> | undefined;
  // The launch is held to the drive's own time: its stop ends the browser's
  // process, started or still starting, by its own handle, so a browser
  // that never answers its launch dies with the drive.
  const launchStop = new AbortController();
  const stopLaunch = () => launchStop.abort();
  const watchdog = setTimeout(
    () => {
      // The hard stop: a render past its budget dies, it never lingers — and the outcome is
      // deterministically the coded timeout (a watchdog expiry must never read as render_failed).
      timedOut = true;
      stopLaunch();
      if (browser) void endOutright(browser);
    },
    Math.max(deadline - Date.now(), 1),
  );
  try {
    drive.stand();
    const driver = drive.driver ?? (await puppeteerDriver());
    try {
      // Launch is inside the budget too: a stalled
      // launch races the remaining deadline; a late arrival is closed.
      launches += 1;
      const launching = trackRenderWork(drive.accountId, driver.launch(chromiumPath(), CHROMIUM_FLAGS, {
        appOrigin: new URL(drive.url).origin,
        deadline,
        requestBoundMs,
        signal: drive.signal,
        launchTimeoutMs: Math.max(deadline - Date.now(), 1),
        stop: launchStop.signal,
        exited: (gone) => { launchExit = gone; },
      }));
      launching.catch(() => {});
      browser = await new Promise<RenderBrowser>((resolve, reject) => {
        let finished = false;
        const finish = (settle: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          drive.signal?.removeEventListener("abort", onAbort);
          settle();
        };
        const timer = setTimeout(
          () => finish(() => {
            timedOut = true;
            stopLaunch();
            reject(renderTimeout(budget));
          }),
          Math.max(deadline - Date.now(), 1),
        );
        // The caller's departure aborts a slow launch too: the slot must
        // not sit held behind a stuck startup.
        const onAbort = () => finish(() => {
          stopLaunch();
          reject(new EvaluationCancelled());
        });
        drive.signal?.addEventListener("abort", onAbort, { once: true });
        if (drive.signal?.aborted) onAbort();
        void launching.then(
          (arrived) => finish(() => resolve(arrived)),
          (error) => finish(() => reject(error)),
        );
      }).catch((error: unknown) => {
        // Gone once a late arrival has been ended outright, or a launch that
        // failed has seen its process exit.
        lateEnd = launching.then((late) => late.kill(), () => launchExit).then(() => {}, () => {});
        throw error;
      });
    } catch (error) {
      if (drive.signal?.aborted) throw new EvaluationCancelled();
      if (timedOut || Date.now() >= deadline) throw renderTimeout(budget);
      if (error instanceof ApiError || error instanceof AuthError || error instanceof EvaluationCancelled) throw error;
      throw new ApiError(
        "render_unavailable",
        "The image renderer's browser is not available on this instance. " +
          "Check DEZFIL_CHROMIUM_PATH, or use the builder's own download.",
        503,
      );
    }
    if (drive.signal?.aborted) throw new EvaluationCancelled();
    drive.stand();
    const open = browser;
    const outcome = await awaitActiveRender(
      open,
      {
        url: drive.url,
        credential: drive.credential,
        width: drive.definition.size.width,
        height: drive.definition.size.height,
        definition: drive.definition,
        deadline,
        requestBoundMs,
      },
      deadline,
      drive.signal,
      budget,
      drive.accountId,
      () => endOutright(open),
    );
    drive.stand();
    settled = true;
    if (drive.signal?.aborted) throw new EvaluationCancelled();
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
    if (drive.signal?.aborted) throw new EvaluationCancelled();
    if (timedOut || (!settled && Date.now() >= deadline)) {
      throw renderTimeout(budget);
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
      // The drive settles, and its caller gives the slot back, only once the
      // browser is gone: closed, or ended outright and its process exited,
      // whether that end came from the deadline, the caller's departure or a
      // close past its grace. The close is held to the time left, so a
      // browser still closing at the deadline is ended then, for every caller.
      const open = browser;
      const graceMs = Math.min(CLOSE_GRACE_MS, Math.max(deadline - Date.now(), 0));
      await endBrowser(open, graceMs, drive.accountId, () => endOutright(open));
      if (ended) await ended;
    } else {
      // A launch that never handed over its browser ends with the drive:
      // it is gone once it has given up, or a late arrival has been ended
      // outright, within the bound. A caller that answers first holds its
      // slot until then.
      stopLaunch();
      if (lateEnd) {
        const gone = within(lateEnd, BROWSER_EXIT_BOUND_MS);
        if (drive.hold) drive.hold(gone);
        else await gone;
      }
    }
  }
}
