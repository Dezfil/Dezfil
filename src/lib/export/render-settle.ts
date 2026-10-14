/** Executed in the render document at its first request cut. Keep this
 * self-contained for serialization into the page, and retain the signal
 * if the map has not mounted yet. It never cancels or restarts a fetch. */
export function settleRenderTiles(): void {
  document.documentElement.dataset.exportTilesSettled = "true";
}

/** Only the render driver's cut relaxes tile readiness. */
export function renderTilesSettled(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.exportTilesSettled === "true";
}
