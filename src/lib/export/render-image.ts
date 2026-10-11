import { admitResourceWork, inDeletionWork, registerRenderDeletionWork } from "@/lib/auth/account-deletion-work";
import { drainAccountRenders } from "./render-work";
import { trackRenderWork } from "./render-work";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { onCommittedSettings } from "@/lib/settings/state";
import { renderRequestBoundMs } from "./render-stall";
import { driveLaunches, driveRender, renderTimeout, type RenderBudget, type RenderImageResult } from "./render-drive";
import { RENDER_CHECK_DEFINITION, RENDER_CHECK_PATH } from "./render-check";
import type { RenderDriver } from "./render-driver";
export type { RenderBrowser, RenderDriver } from "./render-driver";
export type { RenderImageResult } from "./render-drive";
import type { ExportImageDefinition } from "./image-definition";

/**
 * The server image renderer: drive a headless browser at the bare render
 * route and screenshot the settled composition. Bounded and honest — a
 * documented budget spans queue wait through response, a documented
 * concurrency cap holds software-GL pressure, and caller departure,
 * timeout, and crash each kill the browser process and release the slot.
 * Every failure is a documented coded error; health is never touched.
 * The drive itself, from a held slot to the screenshot, is
 * `render-drive.ts`.
 */

// ---- the slot queue (documented cap; budget covers the wait) ----

interface Waiter { start: () => boolean; }

const slotKey = Symbol.for("dezfil.image-lane");
const shared = process as typeof process & { [slotKey]?: { active: number; waiters: Waiter[] } };
const slots = shared[slotKey] ??= { active: 0, waiters: [] as Waiter[] };
const { waiters } = slots;

function pumpSlots(): void {
  while (slots.active < limits.exportRenderConcurrency && waiters.length) {
    if (waiters.shift()!.start()) slots.active += 1;
  }
}
onCommittedSettings("image-lane", pumpSlots);

function releaseSlot(): void {
  slots.active -= 1;
  pumpSlots();
}

function acquireSlot(deadline: number, signal: AbortSignal | undefined, budget: RenderBudget): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const leave = (error: unknown) => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      cleanup(); reject(error);
    };
    const waiter: Waiter = { start: () => {
      // A commit or release can pump before an expired waiter's timer fires.
      if (signal?.aborted) { leave(new EvaluationCancelled()); return false; }
      if (Date.now() >= deadline) { leave(renderTimeout(budget)); return false; }
      cleanup(); resolve(); return true;
    } };
    const timer = setTimeout(() => leave(renderTimeout(budget)), Math.max(deadline - Date.now(), 1));
    const onAbort = () => leave(new EvaluationCancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    waiters.push(waiter);
    pumpSlots();
  });
}

/** Take a slot now, when one is free and no image waits for one; never
 * queue. Whoever takes one releases it. */
function takeSlotNow(): boolean {
  if (waiters.length > 0 || slots.active >= limits.exportRenderConcurrency) return false;
  slots.active += 1;
  return true;
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

/** Render one map to PNG under the documented bounds. */
export function renderMapImage(scope: AccountScope, input: RenderImageInput): Promise<RenderImageResult> {
  const accountId = requireAccountScope(scope);
  const lease = admitResourceWork(scope, [{ table: "maps", id: input.mapId }]);
  const unregister = registerRenderDeletionWork(input.credential, lease);
  const rendering = trackRenderWork(accountId, inDeletionWork(lease, () => performRenderMapImage(scope, input)));
  return rendering.then(result => { lease.assertCommit(); return result; }).finally(() => {
    // A timed-out response can precede browser launch/render/close settlement.
    void drainAccountRenders(accountId).finally(() => { unregister(); lease.release(); });
  });
}

async function performRenderMapImage(
  scope: AccountScope,
  input: RenderImageInput,
): Promise<RenderImageResult> {
  // Asked again at every phase: before the queue, after the slot, after the
  // launch and after the render.
  const stand = () => { requireAccountScope(scope); input.standing?.(); };
  stand();
  const budget: RenderBudget = { timeoutMs: input.budgetMs ?? limits.exportRenderTimeoutMs, check: input.budgetMs !== undefined };
  const requestBoundMs = renderRequestBoundMs(input.budgetMs);
  const deadline = Date.now() + budget.timeoutMs;
  await acquireSlot(deadline, input.signal, budget);
  // A launch given up on at the budget may still be starting when the
  // export answers: the slot stays held until it has ended.
  const late: { end: Promise<void> | null } = { end: null };
  try {
    return await driveRender({
      url: `${input.baseUrl}/render/${encodeURIComponent(input.mapId)}`,
      credential: input.credential,
      definition: input.definition,
      deadline,
      requestBoundMs,
      budget,
      signal: input.signal,
      driver: input.driver,
      accountId: scope.accountId,
      stand,
      hold: (end) => { late.end = end; },
    });
  } finally {
    if (late.end) void late.end.then(releaseSlot);
    else releaseSlot();
  }
}

export interface CheckImageInput {
  baseUrl: string;
  credential: string;
  /** The account the browser's work is tracked against. */
  accountId: string;
  /** The hard stop: the browser is killed and the slot given back by then. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected by unit tests; the real driver otherwise. */
  driver?: RenderDriver;
}

/**
 * The image renderer's Test: one image of the render route's fixed check
 * picture, from no map or data, on a slot taken now. When every slot is
 * in use or an image already waits for one it answers busy at once and
 * launches nothing, so it never queues and never goes ahead of an image.
 * Its slot counts against Images at once like any image's, and an image
 * asked while it runs waits for it as it would behind any image, at most
 * its hard stop.
 */
export async function renderCheckImage(input: CheckImageInput): Promise<RenderImageResult | "busy"> {
  if (!takeSlotNow()) return "busy";
  try {
    return await driveRender({
      url: `${input.baseUrl}${RENDER_CHECK_PATH}`,
      credential: input.credential,
      definition: RENDER_CHECK_DEFINITION,
      deadline: Date.now() + input.timeoutMs,
      requestBoundMs: renderRequestBoundMs(input.timeoutMs),
      budget: { timeoutMs: input.timeoutMs, check: true },
      signal: input.signal,
      driver: input.driver,
      accountId: input.accountId,
      stand: () => {},
    });
  } finally {
    releaseSlot();
  }
}

/** Test seam: the current queue depth (unit assertions only). */
export function renderQueueState(): { active: number; waiting: number } {
  return { active: slots.active, waiting: waiters.length };
}

/** Test and measurement seam: physical launch attempts since the process
 * started, a failed one too (renders counted at the renderer, never
 * from successful results). */
export function renderStats(): { launches: number } {
  return { launches: driveLaunches() };
}
