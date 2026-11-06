/**
 * Where focus goes when a list item's delete removes the item holding it.
 *
 * The deleted card takes its focused button with it, and a browser then
 * drops focus on the document, so the next Tab would start from the top of
 * the page. Focus moves instead to the next card's delete, else the
 * previous card's, else the list's heading. Every card's delete carries
 * `data-card-delete`, whether it asks in place or through a dialog.
 */

/** Every card's delete on the page, in page order. */
export function cardDeletes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-card-delete]"));
}

/** Focus is still on the button, or the page dropped it. */
export function focusLost(button: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === button ||
    active === document.body ||
    !active.isConnected
  );
}

/** The next card's delete, else the previous card's, else the heading. */
export function landAfterRemoval(button: HTMLElement, peers: HTMLElement[]) {
  const at = peers.indexOf(button);
  const order = at < 0 ? [] : [...peers.slice(at + 1), ...peers.slice(0, at).reverse()];
  for (const peer of order) {
    if (!peer.isConnected || (peer as HTMLButtonElement).disabled) continue;
    peer.focus();
    if (document.activeElement === peer) return;
  }
  const heading = document.querySelector("[data-list-heading]")?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (heading.hasAttribute("tabindex")) {
    heading.focus();
    return;
  }
  // The heading takes focus for this landing only.
  heading.setAttribute("tabindex", "-1");
  heading.focus();
  if (document.activeElement === heading) {
    heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
  } else {
    heading.removeAttribute("tabindex");
  }
}
