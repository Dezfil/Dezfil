import type { Dispatch, RefObject, SetStateAction } from "react";
import type * as maplibregl from "@/lib/maplibre";
import type { MapStatus } from "@/lib/map-status";
import type { Viewport } from "./MapCanvas";
import { clampToView, type PinnedPopup } from "./canvas-pointer";

/** Motion state needed before the overlay binds pointer handling. */
export function attachCanvasMotion(
  instance: maplibregl.Map,
  markScaleRef: RefObject<number>,
  clusterZoomRef: RefObject<number>,
  setClusterZoom: (zoom: number) => void,
) {
  // deck's own cursor handling is inert under MapLibreOverlay (its container
  // takes no pointer events), so clickability is signaled on the MapLibre
  // canvas instead: pointer over a picked feature, stock grab/grabbing
  // otherwise. Hover picks can fire mid-pan (the overlay forwards mouse
  // moves without button state), so a drag flag keeps the grabbing hand
  // authoritative while panning.
  let dragging = false;
  const dragstart = () => {
    dragging = true;
    instance.getCanvas().style.cursor = "";
  };
  const dragend = () => {
    dragging = false;
  };
  instance.on("dragstart", dragstart);
  instance.on("dragend", dragend);

  // A press that began on the map and is released anywhere else (over the
  // inspector, a card, the map's own controls) must end the gesture. The
  // map's mouse handlers end it only on a release over the map itself:
  // the release it hears on the document goes to a handler none of them
  // has, so the gesture stayed open, painted but unsaved, until the
  // pointer next moved. Hand that release to the map as its own.
  const surface = instance.getCanvasContainer();
  let pressed = false;
  const press = () => {
    pressed = true;
  };
  const release = (e: MouseEvent) => {
    if (!e.isTrusted || !pressed) return;
    pressed = false;
    if (e.target instanceof Node && surface.contains(e.target)) return;
    surface.dispatchEvent(new MouseEvent("mouseup", e));
  };
  surface.addEventListener("mousedown", press);
  surface.ownerDocument.addEventListener("mouseup", release);

  // Cluster layers re-form at integer zoom steps, at the logical
  // zoom.
  const syncClusterZoom = () => {
    const z = Math.max(
      0,
      Math.floor(instance.getZoom() - Math.log2(markScaleRef.current)),
    );
    if (clusterZoomRef.current !== z) {
      clusterZoomRef.current = z;
      setClusterZoom(z);
    }
  };
  syncClusterZoom();
  instance.on("zoom", syncClusterZoom);

  return {
    isDragging: () => dragging,
    syncClusterZoom,
    dispose: () => {
      instance.off("dragstart", dragstart);
      instance.off("dragend", dragend);
      surface.removeEventListener("mousedown", press);
      surface.ownerDocument.removeEventListener("mouseup", release);
      instance.off("zoom", syncClusterZoom);
    },
  };
}

/** Camera notifications share the map instance's event lifetime. */
export function attachCanvasNotifications({
  instance, onBearingChangeRef, onPitchChangeRef, onViewportChange,
  pinnedRef, setPinned, onStatusRef,
}: {
  instance: maplibregl.Map;
  onBearingChangeRef: RefObject<((bearing: number) => void) | undefined>;
  onPitchChangeRef: RefObject<((pitch: number) => void) | undefined>;
  onViewportChange?: (viewport: Viewport) => void;
  pinnedRef: RefObject<PinnedPopup | null>;
  setPinned: Dispatch<SetStateAction<PinnedPopup | null>>;
  onStatusRef: RefObject<((status: MapStatus) => void) | undefined>;
}) {
  // Compass needle: integer degrees, emitted only on change, so a rotate
  // drag costs at most one React update per visible degree.
  let lastBearing = Math.round(instance.getBearing());
  onBearingChangeRef.current?.(lastBearing);
  const rotate = () => {
    const b = Math.round(instance.getBearing());
    if (b !== lastBearing) {
      lastBearing = b;
      onBearingChangeRef.current?.(b);
    }
  };
  instance.on("rotate", rotate);

  // Tilt state: integer degrees, emitted only on change.
  let lastPitch = Math.round(instance.getPitch());
  onPitchChangeRef.current?.(lastPitch);
  const pitch = () => {
    const p = Math.round(instance.getPitch());
    if (p !== lastPitch) {
      lastPitch = p;
      onPitchChangeRef.current?.(p);
    }
  };
  instance.on("pitch", pitch);

  const moveend = () => {
    if (onViewportChange) {
      const c = instance.getCenter();
      onViewportChange({
        lng: c.lng,
        lat: c.lat,
        zoom: instance.getZoom(),
        pitch: Math.round(instance.getPitch()),
        bearing: Math.round(instance.getBearing() * 10) / 10,
      });
    }
  };
  if (onViewportChange) instance.on("moveend", moveend);

  // The pinned pop-up is anchored to a map coordinate: reproject it to
  // screen space as the view moves so it rides with its feature. Clamped
  // here (not at render) so small viewports keep the card reachable.
  const move = () => {
    const p = pinnedRef.current;
    if (!p) return;
    const pt = instance.project([p.lng, p.lat]);
    const [x, y] = clampToView(instance, pt.x, pt.y);
    setPinned((cur) => (cur ? { ...cur, x, y } : cur));
  };
  instance.on("move", move);

  // Live status for the builder's status bar. Emissions are coalesced to
  // animation frames so a continuous pan plus pointer motion costs one
  // update per frame. Published views pass no sink, so nothing is bound
  // there.
  let statusFrame = 0;
  let disposeStatus = () => {};
  if (onStatusRef.current) {
    let cursor: { lng: number; lat: number } | null = null;
    const push = () => {
      statusFrame = 0;
      const sink = onStatusRef.current;
      if (!sink) return;
      const b = instance.getBounds();
      sink({
        cursor,
        zoom: instance.getZoom(),
        pitch: Math.round(instance.getPitch()),
        bounds: [
          [b.getWest(), b.getSouth()],
          [b.getEast(), b.getNorth()],
        ],
      });
    };
    const schedule = () => {
      if (!statusFrame) statusFrame = requestAnimationFrame(push);
    };
    const mousemove = (e: maplibregl.MapMouseEvent) => {
      cursor = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      schedule();
    };
    const mouseout = () => {
      cursor = null;
      schedule();
    };
    instance.on("mousemove", mousemove);
    instance.on("mouseout", mouseout);
    instance.on("move", schedule);
    disposeStatus = () => {
      instance.off("mousemove", mousemove);
      instance.off("mouseout", mouseout);
      instance.off("move", schedule);
    };
    schedule();
  }

  return () => {
    if (statusFrame) cancelAnimationFrame(statusFrame);
    disposeStatus();
    instance.off("rotate", rotate);
    instance.off("pitch", pitch);
    if (onViewportChange) instance.off("moveend", moveend);
    instance.off("move", move);
  };
}
