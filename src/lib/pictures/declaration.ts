/** The stamp is written only after a real style loads. Missing means the
 * fallback, even when the map itself reports idle. */
export function readPaintedStyle(root: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | null {
  return root.querySelector("[data-painted-basemap]")?.getAttribute("data-painted-basemap") ?? null;
}
export function unsupportedRenderLayers(layers: readonly { id: string; tiled: boolean; liveDimensions: number }[]): string[] {
  return layers.filter(layer => layer.tiled && layer.liveDimensions > 0).map(layer => layer.id);
}
