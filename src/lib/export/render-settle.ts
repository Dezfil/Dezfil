/** Executed in the render document at every request cut. The signal is
 * idempotent. Keep this self-contained for serialization, and retain it
 * if the map has not mounted yet. It never cancels or restarts a fetch. */
export function settleRenderTiles(): void {
  document.documentElement.dataset.exportTilesSettled = "true";
}

/** Only the render driver's cut relaxes tile readiness. */
export function renderTilesSettled(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.exportTilesSettled === "true";
}
