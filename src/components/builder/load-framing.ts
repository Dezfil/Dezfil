/**
 * Whether a load of the map frames its data.
 *
 * The first load opens at the saved view, unless the page says the map has
 * no view of its own yet. A later load (an assistant turn, undo or redo,
 * Reload) frames only when it brings a layer the previous one did not have:
 * that is how a layer added through the catalog's SQL or by the assistant
 * comes into view. Any other later load leaves the camera where the person
 * put it.
 */
export function loadFrames(
  previous: ReadonlySet<string> | null,
  loaded: readonly string[],
  framedOpening: boolean,
): boolean {
  if (previous === null) return framedOpening;
  return loaded.some((id) => !previous.has(id));
}
