import type { Viewport } from "@/lib/metadata/maps";
import type { InstanceDefaults } from "@/lib/settings/defaults";

/** Where a new map opens, from the instance's defaults. The product's own
 * view opens on the populated world: zoomed to ~1.3 and biased north so
 * the canvas clamp pins the view just under the top of the world,
 * Greenland to the Southern Ocean, no dead space above. */
export function startingView(defaults: InstanceDefaults): Viewport {
  return { lng: defaults["newMap.longitude"], lat: defaults["newMap.latitude"], zoom: defaults["newMap.zoom"] };
}

/**
 * Whether a map opens framed to its data rather than at its saved view.
 *
 * A map opens where it was saved, which is also what its card picture
 * shows. Only a map still at the starting view it was made with has no
 * view of its own yet (made through the API or the assistant and never
 * framed), so its first opening frames what it draws. A camera move, a view
 * set through the API and a layer added in the builder all replace the
 * starting view; a copy carries its source's view, whichever it is.
 *
 * The comparison is with the starting view the instance offers now: a map
 * made before an administrator moved it reads as having a view of its own
 * and opens where its card shows it.
 */
export function opensFramed(viewport: Viewport, defaults: InstanceDefaults): boolean {
  const start = startingView(defaults);
  return viewport.lng === start.lng && viewport.lat === start.lat && viewport.zoom === start.zoom
    && (viewport.pitch ?? 0) === 0 && (viewport.bearing ?? 0) === 0;
}
