/**
 * Legend ordering: one pure decision, made once, for every surface that
 * renders the legend — the builder overlay, the published view, and
 * both image-export roads.
 *
 * Automatic (no stored arrangement) mirrors the layer panel: the stored
 * array is bottom-up (drawing order), the panel shows it reversed, and
 * the legend reads the panel's way. A manual arrangement lists layer
 * ids top-first; layers it does not know — added after the arrangement
 * was written — enter at the top, in their automatic order among
 * themselves, exactly where the panel puts new layers.
 */
export function orderForLegend<T extends { id?: string }>(
  layers: readonly T[],
  legendOrder: readonly string[] | null | undefined,
): T[] {
  const automatic = [...layers].reverse();
  if (!legendOrder || legendOrder.length === 0) return automatic;
  const slot = new Map(legendOrder.map((id, i) => [id, i]));
  const arranged = automatic
    .filter((l) => l.id !== undefined && slot.has(l.id))
    .sort((a, b) => slot.get(a.id!)! - slot.get(b.id!)!);
  const entering = automatic.filter(
    (l) => l.id === undefined || !slot.has(l.id),
  );
  return [...entering, ...arranged];
}

/** Keep only layers whose current render can honestly contribute a legend
 * row. Published and exported views share this eligibility decision so a
 * failed render is never advertised on one surface but omitted on another. */
export function successfulLegendLayers<T>(
  layers: readonly T[],
  renderSucceeded: (layer: T) => boolean,
): T[] {
  return layers.filter(renderSucceeded);
}
