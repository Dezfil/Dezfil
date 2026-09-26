import { PAINTED_BASEMAP_KEY } from "./capture";

/**
 * Which style is painted, stamped on the host at each style load. The
 * stamp names the request that completed, never the latest requested:
 * MapLibre fires "style.load" without a detail when a fresh style
 * object finishes loading and with a `style` detail when a diff is
 * applied in place to the loaded style, and a newer diffed request
 * aborts an older one — so the one order that survives is the
 * constructor's initial request completing after a toggle has requested
 * the other style. A detail-less load on the constructor's own style
 * object is that initial request's; every other load is the latest
 * requested URL's. The fallback clears the stamp.
 */

export interface PaintedStyleStamp {
  onStyleLoad: (
    event: { style?: unknown },
    latestRequestedUrl: string,
    fallback: boolean,
  ) => void;
}

export function createPaintedStyleStamp(
  instance: { style: unknown },
  host: HTMLElement,
  initialUrl: string,
): PaintedStyleStamp {
  const initialStyle = instance.style;
  return {
    onStyleLoad: (event, latestRequestedUrl, fallback) => {
      if (fallback) {
        delete host.dataset[PAINTED_BASEMAP_KEY];
        return;
      }
      const fresh = !event.style;
      const loaded =
        fresh && instance.style === initialStyle ? initialUrl : latestRequestedUrl;
      host.dataset[PAINTED_BASEMAP_KEY] = loaded;
    },
  };
}
