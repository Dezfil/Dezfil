import type maplibregl from "maplibre-gl";

/** A read-only snapshot of the map's live camera. Kept here rather than
 * importing MapCanvas's public Viewport type, because MapCanvas owns and
 * constructs this handle. The two shapes are deliberately structural. */
export interface CameraViewport {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * The canvas's imperative camera, handed to a host once on mount and
 * nulled on teardown. One shape, so the control stack and the canvas
 * cannot restate it differently.
 */
export interface CameraHandle {
  /** Read the camera MapLibre is drawing now. Hosts that act during an
   * ease must not substitute the last moveend/persistence snapshot. */
  currentViewport: () => CameraViewport;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Jump to an exact zoom. The export card changes the
   * space its composition is laid out in, and a larger space at the same
   * zoom frames more ground — so the camera moves by the same factor to
   * hold it. A jump, not an ease: the preview must be settled by the
   * time the next frame is composed. */
  setZoom: (zoom: number) => void;
  /** Ease bearing and pitch back to a flat, north-up view. */
  resetNorth: () => void;
  /** Ease the camera to a tilt; reduced motion jumps, and
   * animate=false jumps too (slider drags). */
  setPitch: (pitch: number, animate?: boolean) => void;
  /** The live filter ranges the canvas is enforcing RIGHT NOW, per layer
   * and in dimension order. A slider drag and the timeline's playhead move
   * these imperatively, without a re-render, so the settled state a host
   * holds can be behind them — fitting during playback has to read what is
   * actually being drawn. */
  liveRanges: () => Record<string, [number, number][]>;
  /** Ground to screen, in container pixels: the draw overlay
   * renders drafts and vertex handles outside the canvas, and this is
   * the one projection it may use. */
  project: (lngLat: [number, number]) => { x: number; y: number };
  /** Screen to ground — the inverse, for committing drawn positions. */
  unproject: (point: { x: number; y: number }) => [number, number];
  /** Subscribe to every camera change frame (move, zoom, rotate, pitch),
   * for reprojection that must track the camera, not settle after it.
   * Returns the unsubscribe. */
  onCameraMove: (listener: () => void) => () => void;
}

/** The CSS-only reduced-motion rule cannot reach camera eases,
 * so the tilt carries its own guard. */
function cameraMs(ms: number): number {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : ms;
}

export function cameraHandle(
  instance: maplibregl.Map,
  liveRanges: () => Record<string, [number, number][]>,
): CameraHandle {
  return {
    currentViewport: () => {
      const center = instance.getCenter();
      return {
        lng: center.lng,
        lat: center.lat,
        zoom: instance.getZoom(),
        pitch: instance.getPitch(),
        bearing: instance.getBearing(),
      };
    },
    zoomIn: () => {
      instance.zoomIn();
    },
    zoomOut: () => {
      instance.zoomOut();
    },
    setZoom: (zoom: number) => {
      instance.jumpTo({ zoom });
    },
    resetNorth: () => {
      instance.easeTo({ bearing: 0, pitch: 0, duration: 450 });
    },
    setPitch: (pitch: number, animate = true) => {
      instance.easeTo({ pitch, duration: animate ? cameraMs(450) : 0 });
    },
    liveRanges,
    project: (lngLat) => {
      const p = instance.project(lngLat);
      return { x: p.x, y: p.y };
    },
    unproject: (point) => {
      const ll = instance.unproject([point.x, point.y]);
      return [ll.lng, ll.lat];
    },
    onCameraMove: (listener) => {
      instance.on("move", listener);
      return () => {
        instance.off("move", listener);
      };
    },
  };
}
