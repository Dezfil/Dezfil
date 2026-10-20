import type * as maplibregl from "maplibre-gl";

/** Where the map stamps its host while it is at rest. */
export const MAP_IDLE_KEY = "mapIdle";

/**
 * Whether the map is at rest, stamped on its host: set at MapLibre's
 * "idle" (no camera moving, the style and every tile it asked for
 * loaded, no fade running) and cleared as soon as data starts loading
 * again or the camera moves. Beside the painted-style stamp, which names
 * a real style once it has loaded, it lets a browser driven from outside
 * the app, such as the documentation's picture script, wait until the
 * basemap is drawn rather than only requested. A tile that failed counts
 * as loaded here, as it does for MapLibre, so a caller that needs every
 * tile watches its requests too. Returns a disposer that stops listening
 * and clears the stamp.
 */
export function attachIdleStamp(
  instance: Pick<maplibregl.Map, "on" | "off">,
  host: HTMLElement,
): () => void {
  const rest = () => {
    host.dataset[MAP_IDLE_KEY] = "";
  };
  const busy = () => {
    delete host.dataset[MAP_IDLE_KEY];
  };
  instance.on("idle", rest);
  instance.on("dataloading", busy);
  instance.on("movestart", busy);
  return () => {
    instance.off("idle", rest);
    instance.off("dataloading", busy);
    instance.off("movestart", busy);
    busy();
  };
}
