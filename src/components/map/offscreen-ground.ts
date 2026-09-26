import maplibregl from "maplibre-gl";
import type { BasemapKind } from "@/lib/basemap";
import {
  authoredBasemapVisibility,
  basemapLayerVisibilities,
  type BasemapLayers,
  type StyleLayerLike,
} from "@/lib/basemap-layers";
import { attachCanvasCamera, CANVAS_CAMERA_OPTIONS } from "./canvas-camera";
import type { PaintedCamera, ThumbnailCapture } from "./capture";
import { isFallbackStyle } from "./use-basemap-style";

/**
 * The other theme's ground for a map's card image. The only way this
 * application changes basemaps is a style URL that loads asynchronously
 * and mutates the visible renderer, so the live map is never touched: a
 * transient map is constructed off-viewport, in a hidden host of the
 * live host's CSS size, on the other theme's style, at the complete
 * painted camera — the builder's asymmetric padding set before first
 * paint and the same latitude constraint the live camera runs under —
 * with the map's basemap group toggles applied to its own authored
 * visibilities. Once it settles, its canvas is copied out and the
 * instance is disposed, on every exit path, which releases its GL
 * context. A root style that cannot load yields the plain fallback
 * ground the live canvas would show in that theme; a timeout or an
 * abandonment rejects, and the caller keeps the map's previous images.
 */

export interface OffscreenGroundRequest {
  styleUrl: string;
  camera: PaintedCamera;
  host: ThumbnailCapture["host"];
  basemapLayers: BasemapLayers | null;
  basemapKind: BasemapKind;
  /** Painted where the ground has nothing, and the whole ground when the
   * style itself cannot load. */
  fallbackColor: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The pieces a test replaces: the map factory and the document. */
export interface OffscreenGroundDeps {
  createMap: (options: maplibregl.MapOptions) => maplibregl.Map;
  document: Pick<Document, "createElement" | "body">;
}

const defaultDeps = (): OffscreenGroundDeps => ({
  createMap: (options) => new maplibregl.Map(options),
  document,
});

/** Marks the hidden host, so a test can count what is left behind. */
export const OFFSCREEN_GROUND_ATTRIBUTE = "data-offscreen-ground";

export class OffscreenGroundError extends Error {
  constructor(
    public readonly reason: "timeout" | "abandoned" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "OffscreenGroundError";
  }
}

function hiddenHost(
  doc: OffscreenGroundDeps["document"],
  host: ThumbnailCapture["host"],
): HTMLDivElement {
  const el = doc.createElement("div");
  el.setAttribute(OFFSCREEN_GROUND_ATTRIBUTE, "");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    left: `${-(host.cssWidth + 64)}px`,
    width: `${host.cssWidth}px`,
    height: `${host.cssHeight}px`,
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
  });
  return el;
}

/** A ground of one colour at the map's device size: what the live canvas
 * shows in a theme whose style cannot load. */
function plainGround(
  doc: OffscreenGroundDeps["document"],
  width: number,
  height: number,
  color: string,
): HTMLCanvasElement {
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * Render the ground and resolve with a 2D copy of the map's canvas at
 * its device-pixel size. Rejects with an OffscreenGroundError on timeout,
 * abandonment, or an unreadable canvas; disposes the instance and the
 * host on every path.
 */
export function renderOffscreenGround(
  req: OffscreenGroundRequest,
  deps: OffscreenGroundDeps = defaultDeps(),
): Promise<HTMLCanvasElement> {
  const { document: doc } = deps;
  const devicePixels = {
    width: Math.round(req.host.cssWidth * req.host.pixelRatio),
    height: Math.round(req.host.cssHeight * req.host.pixelRatio),
  };
  const host = hiddenHost(doc, req.host);
  doc.body.appendChild(host);
  let instance: maplibregl.Map | null = null;
  let disposeCamera: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const onAbort = () => finish(null, new OffscreenGroundError("abandoned", "Superseded."));
  let settled = false;
  let resolveOut: (canvas: HTMLCanvasElement) => void = () => {};
  let rejectOut: (error: Error) => void = () => {};
  const out = new Promise<HTMLCanvasElement>((resolve, reject) => {
    resolveOut = resolve;
    rejectOut = reject;
  });

  const dispose = () => {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    req.signal?.removeEventListener("abort", onAbort);
    disposeCamera?.();
    try {
      instance?.remove();
    } catch {
      // Already gone; the host goes regardless.
    }
    instance = null;
    host.remove();
  };
  const finish = (canvas: HTMLCanvasElement | null, error?: Error) => {
    if (settled) return;
    settled = true;
    dispose();
    if (canvas) resolveOut(canvas);
    else rejectOut(error ?? new OffscreenGroundError("unreadable", "No ground."));
  };

  if (req.signal?.aborted) {
    finish(null, new OffscreenGroundError("abandoned", "Superseded."));
    return out;
  }
  req.signal?.addEventListener("abort", onAbort);
  timer = setTimeout(
    () =>
      finish(
        null,
        new OffscreenGroundError("timeout", "The ground did not settle in time."),
      ),
    req.timeoutMs,
  );

  try {
    const map = deps.createMap({
      container: host,
      style: req.styleUrl,
      center: [req.camera.lng, req.camera.lat],
      zoom: req.camera.zoom,
      pitch: req.camera.pitch,
      bearing: req.camera.bearing,
      ...CANVAS_CAMERA_OPTIONS,
      interactive: false,
      attributionControl: false,
      pixelRatio: req.host.pixelRatio,
      // The ground is read once it settles; nothing is watched fade in.
      fadeDuration: 0,
    });
    instance = map;
    // The complete painted camera: padding before first paint, then the
    // shared constraint (which re-applies centre and zoom under it), so
    // the ground sits exactly under the overlay it will carry.
    map.setPadding(req.camera.padding);
    disposeCamera = attachCanvasCamera(map, host, req.camera);

    // The style's own failure (the root, never a tile or a glyph) means
    // the live canvas would show the plain fallback in this theme, so the
    // ground is that plain colour — not a failed cycle.
    let rootPending = true;
    map.on("style.load", () => {
      const style = map.getStyle();
      if (style && isFallbackStyle(style)) return;
      rootPending = false;
      const layers = (style?.layers ?? []) as (StyleLayerLike & {
        layout?: { visibility?: string };
      })[];
      const authored = authoredBasemapVisibility(layers);
      for (const { id, visibility } of basemapLayerVisibilities({
        kind: req.basemapKind,
        layers,
        toggles: req.basemapLayers,
        authored: (layerId) => authored.get(layerId),
      })) {
        if (visibility !== (authored.get(id) ?? "visible")) {
          map.setLayoutProperty(id, "visibility", visibility);
        }
      }
    });
    map.on("error", (e) => {
      const err = e?.error as { message?: string; url?: string | URL } | undefined;
      const sourceId = (e as { sourceId?: string }).sourceId;
      const failedResource = err?.url ? String(err.url) : null;
      const msg = String(err?.message ?? "");
      const rootFailure =
        !sourceId &&
        (failedResource === req.styleUrl ||
          (failedResource === null &&
            rootPending &&
            !/tile|glyph|sprite/i.test(msg)));
      if (!rootFailure) return;
      rootPending = false;
      finish(
        plainGround(doc, devicePixels.width, devicePixels.height, req.fallbackColor),
      );
    });

    // Settled: the style loaded, every tile in, nothing moving. Read the
    // canvas inside a render event, the only place the buffer is whole.
    const read = () => {
      map.once("render", () => {
        try {
          const source = map.getCanvas();
          const copy = doc.createElement("canvas");
          copy.width = source.width;
          copy.height = source.height;
          const ctx = copy.getContext("2d");
          if (!ctx || source.width === 0 || source.height === 0) {
            finish(null, new OffscreenGroundError("unreadable", "No canvas."));
            return;
          }
          ctx.fillStyle = req.fallbackColor;
          ctx.fillRect(0, 0, copy.width, copy.height);
          ctx.drawImage(source, 0, 0);
          finish(copy);
        } catch {
          finish(null, new OffscreenGroundError("unreadable", "Unreadable canvas."));
        }
      });
      map.triggerRepaint();
    };
    let reading = false;
    const check = () => {
      if (settled || reading || rootPending) return;
      if (map.loaded() && map.areTilesLoaded() && !map.isMoving()) {
        reading = true;
        read();
      }
    };
    map.on("idle", check);
    poll = setInterval(check, 200);
  } catch (error) {
    finish(
      null,
      error instanceof Error
        ? error
        : new OffscreenGroundError("unreadable", "The ground could not start."),
    );
  }
  return out;
}

/**
 * The second image: the rendered ground under the kept overlay, at the
 * composite's size, the theme's fallback colour where the ground has
 * nothing. Null on any failure — the caller drops it in silence.
 */
export function composeOverGround(
  ground: HTMLCanvasElement,
  capture: ThumbnailCapture,
  fallbackColor: string,
  doc: Pick<Document, "createElement"> = document,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const out = doc.createElement("canvas");
      out.width = capture.width;
      out.height = capture.height;
      const ctx = out.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.fillStyle = fallbackColor;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(ground, 0, 0, out.width, out.height);
      ctx.drawImage(capture.overlay, 0, 0, out.width, out.height);
      out.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}
