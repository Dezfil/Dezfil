import type * as maplibregl from "maplibre-gl";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import { renderTilesSettled } from "@/lib/export/render-settle";

/**
 * Canvas capture for the map surface — extracted from MapCanvas (the
 * decomposition habit's at-touch slice). Two consumers:
 *
 * - The 640px thumbnail, behavior-preserved: composite the
 *   basemap and deck canvases in DOM order, downscaled, resolving null on
 *   any failure — thumbnails are a nicety and their caller drops nulls in
 *   silence by design.
 * - The export card's full-resolution capture, which is the
 *   opposite contract: every failure is a thrown CaptureError the card
 *   must surface. The map's pixel ratio and the deck overlay's
 *   device-pixel setting are raised so both WebGL backing buffers render
 *   at the target size, the map settles idle, the composite is read
 *   inside a render event (the basemap's buffer is only readable there —
 *   no preserved buffer, that would perturb rendering everywhere else),
 *   and the settings are restored on every outcome. Backing sizes are
 *   validated first: a renderer that clamped or resized on a different
 *   frame must fail loudly, never download a nominally correct image
 *   (raised at review).
 */

export class CaptureError extends Error {
  constructor(
    /** Which validation refused: sizing, readback, or settle timeout. */
    public readonly reason: "clamped" | "unreadable" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

/** How long a raised-resolution render may take to settle before the
 * capture fails visibly instead of leaving the card busy forever. */
const SETTLE_TIMEOUT_MS = 20_000;

/** Backing-buffer tolerance in device pixels: rounding, not clamping. */
const SIZE_TOLERANCE = 2;

/** The complete painted camera: not only centre, zoom, pitch
 * and bearing but the view padding the builder frames with — the
 * latitude constraint the live camera runs under is a function of the
 * host height and this padding, so a second map at the same CSS size,
 * the same padding and the same constraint paints the same ground. */
export interface PaintedCamera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

/** What one thumbnail composite yields: the finished PNG for
 * the live theme, and the parts a second theme's image is composed from
 * in the same paint — the deck overlay alone at the composite's size, the
 * painted camera, and the live host's CSS size and pixel ratio. */
export interface ThumbnailCapture {
  blob: Blob;
  width: number;
  height: number;
  /** The data layers over a transparent ground, at width × height. */
  overlay: HTMLCanvasElement;
  camera: PaintedCamera;
  host: { cssWidth: number; cssHeight: number; pixelRatio: number };
  /** The style URL the canvas last loaded (the basemap lifecycle stamps
   * it on the host at style load); null while the offline fallback is
   * showing. A theme switch mid-load leaves the previous style painted,
   * and this says so. */
  paintedStyleUrl: string | null;
}

/** Where the basemap lifecycle stamps the loaded style's URL. */
export const PAINTED_BASEMAP_KEY = "paintedBasemap";

export type SnapshotCapture = () => Promise<ThumbnailCapture | null>;

export type SnapshotHandle = (capture: SnapshotCapture | null) => void;

/** The thumbnail composite: downscale to at most 640 wide, fallback
 * color under the stack, null on any failure. It also keeps the overlay
 * and the painted camera from the same render event. */
export function compositeThumbnail(
  instance: maplibregl.Map,
  fallbackColor: string,
): Promise<ThumbnailCapture | null> {
  return new Promise<ThumbnailCapture | null>((resolve) => {
    instance.once("render", () => {
      try {
        const container = instance.getContainer();
        const canvases = Array.from(container.querySelectorAll("canvas"));
        const base = canvases[0];
        if (!base || base.width === 0 || base.height === 0) {
          resolve(null);
          return;
        }
        const scale = Math.min(1, 640 / base.width);
        const width = Math.max(1, Math.round(base.width * scale));
        const height = Math.max(1, Math.round(base.height * scale));
        const out = document.createElement("canvas");
        out.width = width;
        out.height = height;
        const ctx = out.getContext("2d");
        // The overlay alone: every canvas but the basemap's, over nothing.
        const overlay = document.createElement("canvas");
        overlay.width = width;
        overlay.height = height;
        const overlayCtx = overlay.getContext("2d");
        if (!ctx || !overlayCtx) {
          resolve(null);
          return;
        }
        ctx.fillStyle = fallbackColor;
        ctx.fillRect(0, 0, width, height);
        for (const canvas of canvases) {
          try {
            ctx.drawImage(canvas, 0, 0, width, height);
            if (canvas !== base) overlayCtx.drawImage(canvas, 0, 0, width, height);
          } catch {
            // A detached canvas skips; the rest still lands.
          }
        }
        const center = instance.getCenter();
        const padding = instance.getPadding();
        const camera: PaintedCamera = {
          lng: center.lng,
          lat: center.lat,
          zoom: instance.getZoom(),
          pitch: instance.getPitch(),
          bearing: instance.getBearing(),
          padding: {
            top: padding.top ?? 0,
            right: padding.right ?? 0,
            bottom: padding.bottom ?? 0,
            left: padding.left ?? 0,
          },
        };
        const host = {
          cssWidth: container.clientWidth,
          cssHeight: container.clientHeight,
          pixelRatio: instance.getPixelRatio(),
        };
        const paintedStyleUrl = container.dataset[PAINTED_BASEMAP_KEY] ?? null;
        out.toBlob(
          (blob) =>
            resolve(
              blob
                ? { blob, width, height, overlay, camera, host, paintedStyleUrl }
                : null,
            ),
          "image/png",
        );
      } catch {
        resolve(null);
      }
    });
    instance.triggerRepaint();
  });
}

export interface CaptureTarget {
  width: number;
  height: number;
}

/** A load probe over the caller's live deck layer instances: loaded when
 * every layer reports so (tile layers report per-sublayer). */
export function layersLoadedProbe(
  get: () => readonly unknown[],
): () => boolean {
  return () =>
    get().every((l) => (l as { isLoaded?: boolean }).isLoaded !== false);
}

/** How often the readiness probe re-evaluates while unready. */
const READINESS_POLL_MS = 200;

/** Hand both capture handles to their consumers at map mount — the
 * thumbnail (contract) and the validated full-res export capture — and,
 * for the bare render route, a readiness signal: the map idle with its
 * committed deck layer set fully loaded. The commitment check is
 * generation-aware by construction — the initially empty deck state can
 * never read as ready when layers are expected, because the caller's
 * expected count gates it. After the render driver's settle signal, replace
 * the whole basemap-load condition (style JSON, sprite, glyphs and tiles):
 * within one poll (200 ms), request a paint of the available content and
 * wait for that paint instead. loaded() cannot remain beside painted,
 * because the same pending tile also holds loaded() false and would stall
 * readiness again. This covers any host or thread without reloading a source.
 * Lives here so MapCanvas carries one call,
 * not the wiring. Returns a disposer for the poll. */
export function wireCaptureHandles(opts: {
  instance: maplibregl.Map;
  overlay: MapLibreOverlay;
  fallbackColor: () => string;
  deckLayers: () => readonly unknown[];
  expectedLayerCount?: () => number;
  onSnapshotHandle?: SnapshotHandle;
  onCaptureHandle?: (capture: CaptureAtSize | null) => void;
  onReadiness?: (ready: boolean) => void;
}): () => void {
  opts.onSnapshotHandle?.(() =>
    compositeThumbnail(opts.instance, opts.fallbackColor()),
  );
  opts.onCaptureHandle?.((target) =>
    captureAtSize(
      opts.instance,
      opts.overlay,
      target,
      opts.fallbackColor(),
      layersLoadedProbe(opts.deckLayers),
    ),
  );
  if (!opts.onReadiness) return () => {};
  const loaded = layersLoadedProbe(opts.deckLayers);
  let last: boolean | null = null;
  let settling = false;
  let painted = false;
  const onSettledPaint = () => { painted = true; evaluate(); };
  const evaluate = () => {
    if (!settling && renderTilesSettled()) {
      settling = true;
      opts.instance.once("render", onSettledPaint);
      opts.instance.triggerRepaint();
    }
    const committed =
      opts.deckLayers().length >= (opts.expectedLayerCount?.() ?? 0);
    const ready =
      (settling ? painted : opts.instance.loaded() && opts.instance.areTilesLoaded()) &&
      !opts.instance.isMoving() &&
      committed &&
      loaded();
    if (ready !== last) {
      last = ready;
      opts.onReadiness?.(ready);
    }
  };
  const timer = setInterval(evaluate, READINESS_POLL_MS);
  opts.instance.on("idle", evaluate);
  evaluate();
  return () => {
    clearInterval(timer);
    opts.instance.off("idle", evaluate);
    opts.instance.off("render", onSettledPaint);
  };
}

export type CaptureAtSize = (
  target: CaptureTarget,
) => Promise<HTMLCanvasElement>;

/** Wait for the map AND the data overlay to settle after a device-pixel
 * change, bounded. MapLibre's idle says nothing about deck: deck loads tile layers asynchronously
 * AND applies a device-pixel change only on its own next redraw — observed directly (the overlay
 * canvas read back at preview size while maplibre's was already raised). So the wait observes the
 * actual conditions: layer load state through the caller's probe, and both backing buffers at their
 * expected size, nudging deck's redraw each pass. The read-time
 * validation stays as the final gate. */
async function settled(
  instance: maplibregl.Map,
  overlay: MapLibreOverlay,
  overlayLoaded: () => boolean,
  buffersAtSize: () => boolean,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      instance.off("idle", onIdle);
      reject(
        new CaptureError(
          "timeout",
          "The map did not settle at export resolution in time.",
        ),
      );
    }, SETTLE_TIMEOUT_MS);
    const onIdle = () => {
      clearTimeout(timer);
      resolve();
    };
    instance.once("idle", onIdle);
    instance.triggerRepaint();
  });
  while (!overlayLoaded() || !buffersAtSize()) {
    if (Date.now() > deadline) {
      throw new CaptureError(
        "timeout",
        !overlayLoaded()
          ? "The data layers did not finish loading at export resolution in time."
          : "The map surface did not reach export resolution in time.",
      );
    }
    // Deck redraws on its own loop; a repaint alone does not wake it.
    // The redraw call is deck's public instance API reached through the
    // overlay's internal handle, guarded to a no-op if that handle changes;
    // the read-time validation still catches an unsettled canvas.
    (
      overlay as unknown as { _deck?: { redraw?: (reason: string) => void } }
    )._deck?.redraw?.("export-capture");
    instance.triggerRepaint();
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * Capture the map stack at exactly `target` pixels. The caller owns the
 * surrounding busy state; this owns raising, validating, reading, and
 * restoring. Throws CaptureError; never resolves a wrong-size canvas.
 */
export async function captureAtSize(
  instance: maplibregl.Map,
  overlay: MapLibreOverlay,
  target: CaptureTarget,
  fallbackColor: string,
  /** Whether the deck overlay's layers have all finished loading — the
   * caller owns the layer instances the overlay renders. */
  overlayLoaded: () => boolean = () => true,
): Promise<HTMLCanvasElement> {
  const container = instance.getContainer();
  const cssWidth = container.clientWidth;
  const cssHeight = container.clientHeight;
  if (cssWidth === 0 || cssHeight === 0) {
    throw new CaptureError("unreadable", "The preview has no size yet.");
  }
  const ratio = target.width / cssWidth;
  const restoreRatio = window.devicePixelRatio || 1;
  const buffersAtSize = () =>
    Array.from(container.querySelectorAll("canvas")).every((canvas) => {
      const wantW = Math.round((canvas.clientWidth / cssWidth) * target.width);
      const wantH = Math.round(
        (canvas.clientHeight / cssHeight) * target.height,
      );
      return (
        Math.abs(canvas.width - wantW) <= SIZE_TOLERANCE &&
        Math.abs(canvas.height - wantH) <= SIZE_TOLERANCE
      );
    });
  try {
    instance.setPixelRatio(ratio);
    overlay.setProps({ useDevicePixels: ratio });
    await settled(instance, overlay, overlayLoaded, buffersAtSize);

    return await new Promise<HTMLCanvasElement>((resolve, reject) => {
      instance.once("render", () => {
        try {
          const canvases = Array.from(
            container.querySelectorAll("canvas"),
          );
          const base = canvases[0];
          if (!base) {
            reject(
              new CaptureError("unreadable", "The map surface is not ready."),
            );
            return;
          }
          // Validation before composition: both buffers must actually be at target size in BOTH
          // axes — a clamp or a lagging resize fails here, not in the download (a passing width
          // with a stale height stretches wrong framing into a right-sized PNG). A lost WebGL
          // context "draws" transparency and must fail too, not download a fallback-only map.
          for (const canvas of canvases) {
            const wantW = Math.round((canvas.clientWidth / cssWidth) * target.width);
            const wantH = Math.round(
              (canvas.clientHeight / cssHeight) * target.height,
            );
            if (
              Math.abs(canvas.width - wantW) > SIZE_TOLERANCE ||
              Math.abs(canvas.height - wantH) > SIZE_TOLERANCE
            ) {
              reject(
                new CaptureError(
                  "clamped",
                  `A renderer clamped its buffer (${canvas.className || "data layer"}: ${canvas.width}×${canvas.height} of ${wantW}×${wantH} wanted). The output would not truly be ${target.width}×${target.height}. Retry, or pick a smaller size.`,
                ),
              );
              return;
            }
            const gl =
              canvas.getContext("webgl2") ??
              canvas.getContext("webgl");
            if (gl && gl.isContextLost()) {
              reject(
                new CaptureError(
                  "unreadable",
                  "The map's graphics context was lost. Retry, or reload the page.",
                ),
              );
              return;
            }
          }
          const out = document.createElement("canvas");
          out.width = target.width;
          out.height = target.height;
          const ctx = out.getContext("2d");
          if (!ctx) {
            reject(
              new CaptureError("unreadable", "No 2D context for composition."),
            );
            return;
          }
          ctx.fillStyle = fallbackColor;
          ctx.fillRect(0, 0, out.width, out.height);
          for (const canvas of canvases) {
            try {
              ctx.drawImage(canvas, 0, 0, out.width, out.height);
            } catch {
              reject(
                new CaptureError(
                  "unreadable",
                  "A map canvas could not be read.",
                ),
              );
              return;
            }
          }
          resolve(out);
        } catch (error) {
          reject(
            error instanceof CaptureError
              ? error
              : new CaptureError("unreadable", "The capture failed."),
          );
        }
      });
      instance.triggerRepaint();
    });
  } finally {
    instance.setPixelRatio(restoreRatio);
    overlay.setProps({ useDevicePixels: true });
  }
}
