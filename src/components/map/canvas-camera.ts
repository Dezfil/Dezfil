import * as maplibregl from "@/lib/maplibre";
import { MAP_MAX_PITCH, MAP_MAX_ZOOM, MAP_MIN_PITCH, MAP_MIN_ZOOM } from "@/lib/map-runtime-limits";
import type { CameraViewport } from "./camera-handle";

export const CANVAS_CAMERA_OPTIONS = {
  ...maplibregl.MAP_RENDERER_OPTIONS,
  minZoom: MAP_MIN_ZOOM,
  maxZoom: MAP_MAX_ZOOM,
  minPitch: MAP_MIN_PITCH,
  maxPitch: MAP_MAX_PITCH,
};

/** Web-Mercator y normalized to [0, 1] — 0 at the world's north edge
 * (85.051°), 1 at its south. Matches MapLibre's internal projection. */
const mercatorY = (lat: number) =>
  (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const latFromMercatorY = (y: number) =>
  (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

/** The camera slice shared by builder, reader, preview and server render.
 * Keep the world covering the canvas, including asymmetric view padding.
 * The attributes are a test observable, sampled from MapLibre after paint;
 * no host needs its own camera hook or a rounded status label to read it. */
export function attachCanvasCamera(
  instance: maplibregl.Map,
  host: HTMLElement,
  initialViewport: Pick<CameraViewport, "lng" | "lat" | "zoom">,
): () => void {
  const clampZoomToCanvas = () => {
    const h = host.clientHeight;
    if (h > 0) instance.setMinZoom(Math.max(MAP_MIN_ZOOM, Math.log2(h / 512)));
  };
  clampZoomToCanvas();
  instance.on("resize", clampZoomToCanvas);

  instance.setTransformConstrain((lngLat, zoom) => {
    const z = Math.min(Math.max(zoom, instance.getMinZoom()), instance.getMaxZoom());
    const worldSize = 512 * Math.pow(2, z);
    const half = instance.getCanvas().clientHeight / 2;
    const padding = instance.getPadding();
    const offset = ((padding.top ?? 0) - (padding.bottom ?? 0)) / 2;
    const lo = half + offset;
    const hi = worldSize - half + offset;
    const y = mercatorY(lngLat.lat) * worldSize;
    const clamped = lo <= hi ? Math.min(Math.max(y, lo), hi) : (lo + hi) / 2;
    return {
      center: new maplibregl.LngLat(lngLat.lng, latFromMercatorY(clamped / worldSize)),
      zoom: z,
    };
  });

  // MapLibre's constructor already constrained the center without padding.
  // Reapply the request under our coverage rule: the earlier south clamp
  // can be inside the padded range, so installing the override cannot undo it.
  // This runs before paint and before MapCanvas subscribes to camera saves.
  instance.jumpTo({ center: [initialViewport.lng, initialViewport.lat], zoom: initialViewport.zoom });

  const readPaintedCamera = () => {
    const center = instance.getCenter();
    const camera = JSON.stringify({
      lng: center.lng,
      lat: center.lat,
      zoom: instance.getZoom(),
      pitch: instance.getPitch(),
      bearing: instance.getBearing(),
      height: instance.getCanvas().clientHeight,
      padding: instance.getPadding(),
    });
    if (host.dataset.mapCamera !== camera) host.dataset.mapCamera = camera;
    if (host.dataset.cameraPainted !== "true") host.dataset.cameraPainted = "true";
  };
  instance.on("render", readPaintedCamera);
  return () => {
    instance.off("resize", clampZoomToCanvas);
    instance.off("render", readPaintedCamera);
    delete host.dataset.mapCamera;
    delete host.dataset.cameraPainted;
  };
}
