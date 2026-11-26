import { MapLibreOverlay } from "@deck.gl/maplibre";
import { pointerHandlers, type PointerContext } from "./canvas-pointer";
import { wireCaptureHandles } from "./capture";

type CaptureOptions = Omit<Parameters<typeof wireCaptureHandles>[0], "instance" | "overlay">;

/** Own the separate data canvas and its capture consumers. The map owns
 * the control itself and finalizes it when the map is removed. Dispose
 * these consumers first so none can read a canvas during teardown. */
export function attachCanvasOverlay(pointer: PointerContext, capture: CaptureOptions) {
  const overlay = new MapLibreOverlay({
    interleaved: false,
    layers: [],
    ...pointerHandlers(pointer),
    // The canvas is already in the page when the map mounts, so the device
    // need not wait for the document's load: a font file that never answers
    // would hold that load, and with it every mark and label on the map,
    // past the labels' own wait for their face.
    deviceProps: { waitForPageLoad: false },
  });
  pointer.instance.addControl(overlay);
  // Consumers retain handles; capture reads the camera only when invoked.
  // Binding here is safe before the rest of the mount configures the camera.
  const disposeCapture = wireCaptureHandles({
    ...capture,
    instance: pointer.instance,
    overlay,
  });
  return {
    overlay,
    dispose() {
      capture.onCaptureHandle?.(null);
      disposeCapture();
    },
  };
}
