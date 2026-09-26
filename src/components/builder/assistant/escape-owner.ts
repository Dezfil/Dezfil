/**
 * Who owns an Escape press (answer): focus decides. With focus inside
 * the assistant pane the press is the pane's, and the surfaces that
 * would otherwise act on an unclaimed Escape, the Tools drawer and the
 * workflow canvas's selection, hold. With focus outside it the pane
 * holds, whatever else acts. One Escape never both dismisses the pane
 * and clears the canvas selection; a nested control that consumes the
 * press keeps its own priority. Pure but for the element it asks about.
 */
export const ASSISTANT_PANE_SELECTOR = "[data-assistant-pane]";

export function assistantOwnsEscape(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ASSISTANT_PANE_SELECTOR) !== null;
}
