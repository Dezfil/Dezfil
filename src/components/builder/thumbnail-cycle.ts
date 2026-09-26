import type { Theme } from "@/components/theme";
import type { BasemapKind } from "@/lib/basemap";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { ThumbnailCapture } from "../map/capture";
import type { OffscreenGroundRequest } from "../map/offscreen-ground";

/**
 * One capture cycle for a map's card image, and the gates on its second
 * half. The live composite is stored first, as it always was: with no
 * theme for a map on a chosen basemap, under the live theme and a fresh
 * cycle token for a map whose basemap follows the theme. Only then, and
 * only for a theme-following map, is the other theme's ground rendered
 * offscreen, composited under the kept overlay, and stored under the
 * same cycle — which is what publishes the pair.
 *
 * The gates: single-flight, latest wins — a cycle is superseded the
 * moment a newer one enters or the runner is disposed, before its first
 * await, and re-checks after every await, so an older cycle can neither
 * store a stale capture nor abandon a newer ground; a
 * floor between grounds; skipped while the document is hidden (its
 * render loop would not run); a hard timeout handed to the ground; and
 * every failure silent — a cycle that fails simply never completes, and
 * the storage keeps the map's previous images.
 *
 * The theme a capture is stored under is the one actually painted: a toggle shortly before the timer fires leaves the
 * plan saying one theme while the canvas still shows the other's style,
 * so the capture carries the painted style and the sides are chosen by
 * it. Painted on the fallback (no style), the plan's theme stands: the
 * fallback colour follows the theme.
 */

export interface ThemedSide {
  theme: Theme;
  styleUrl: string;
  fallbackColor: string;
}

export interface ThumbnailCyclePlan {
  /** Null for a map whose basemap does not follow the theme. */
  themed: {
    /** The theme the builder is in when the cycle fires. */
    theme: Theme;
    /** That theme's own style and fallback: what the canvas is meant
     * to paint. */
    live: ThemedSide;
    other: ThemedSide;
    basemapLayers: BasemapLayers | null;
    basemapKind: BasemapKind;
  } | null;
}

export interface ThumbnailRunnerDeps {
  capture: () => Promise<ThumbnailCapture | null>;
  /** Store one image under the query (bare, no leading "?"; empty for the
   * single image); true when the server accepted it. */
  upload: (query: string, blob: Blob) => Promise<boolean>;
  renderGround: (req: OffscreenGroundRequest) => Promise<HTMLCanvasElement>;
  compose: (
    ground: HTMLCanvasElement,
    capture: ThumbnailCapture,
    fallbackColor: string,
  ) => Promise<Blob | null>;
  hidden: () => boolean;
  mintCycle: () => string;
}

export interface ThumbnailRunnerOptions {
  /** The least time between two offscreen grounds starting. */
  floorMs: number;
  /** How long a ground may take before the cycle gives up. */
  timeoutMs: number;
}

export interface ThumbnailRunner {
  run: (plan: ThumbnailCyclePlan) => Promise<void>;
  dispose: () => void;
}

/** A cycle token safe in a file name, unique enough across one session. */
export function mintThumbnailCycle(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** Which side the capture actually shows, by its painted style. */
export function paintedSides(
  plan: NonNullable<ThumbnailCyclePlan["themed"]>,
  paintedStyleUrl: string | null,
): { first: ThemedSide; second: ThemedSide } {
  const swapped = paintedStyleUrl === plan.other.styleUrl;
  return swapped
    ? { first: plan.other, second: plan.live }
    : { first: plan.live, second: plan.other };
}

export function createThumbnailRunner(
  deps: ThumbnailRunnerDeps,
  options: ThumbnailRunnerOptions,
): ThumbnailRunner {
  let current: AbortController | null = null;
  let lastGroundStart = -Infinity;

  const run = async (plan: ThumbnailCyclePlan): Promise<void> => {
    // Latest wins, from entry: whatever cycle is running is superseded
    // now, and this one owns the signal it re-checks after every await.
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const { signal } = controller;
    try {
      const capture = await deps.capture();
      if (!capture || signal.aborted) return;
      if (!plan.themed) {
        await deps.upload("", capture.blob);
        return;
      }
      const { basemapLayers, basemapKind } = plan.themed;
      const { first, second } = paintedSides(plan.themed, capture.paintedStyleUrl);
      const cycle = deps.mintCycle();
      const stored = await deps.upload(
        `theme=${first.theme}&cycle=${cycle}`,
        capture.blob,
      );
      if (!stored || signal.aborted || deps.hidden()) return;
      await sleep(lastGroundStart + options.floorMs - Date.now(), signal);
      if (signal.aborted || deps.hidden()) return;
      lastGroundStart = Date.now();
      const ground = await deps.renderGround({
        styleUrl: second.styleUrl,
        camera: capture.camera,
        host: capture.host,
        basemapLayers,
        basemapKind,
        fallbackColor: second.fallbackColor,
        timeoutMs: options.timeoutMs,
        signal,
      });
      if (signal.aborted) return;
      const blob = await deps.compose(ground, capture, second.fallbackColor);
      if (!blob || signal.aborted) return;
      await deps.upload(`theme=${second.theme}&cycle=${cycle}`, blob);
    } catch {
      // Silent by design — a card image is a nicety, and the storage
      // keeps the map's previous images until a cycle completes.
    }
  };

  return {
    run,
    dispose: () => {
      current?.abort();
      current = null;
    },
  };
}
