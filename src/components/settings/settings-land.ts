/**
 * Landing on a row: the element an address names is brought into view
 * under the header and marked for a moment, so the eye finds it. A
 * disclosure it names opens (the shipped password link opens Change
 * password); a card's heading marks the whole card.
 */

/** How long the mark holds before it fades, and the fade itself. */
export const MARK_HOLD_MS = 900;
export const MARK_FADE_MS = 350;

const marks = new WeakMap<Element, ReturnType<typeof setTimeout>[]>();

/** Mark an element briefly: `data-marked` holds, then fades and goes. */
export function markElement(target: Element): void {
  for (const timer of marks.get(target) ?? []) clearTimeout(timer);
  target.setAttribute("data-marked", "");
  const fade = setTimeout(() => {
    target.setAttribute("data-marked", "fading");
    const gone = setTimeout(() => { target.removeAttribute("data-marked"); marks.delete(target); }, MARK_FADE_MS);
    marks.set(target, [gone]);
  }, MARK_HOLD_MS);
  marks.set(target, [fade]);
}

function reducedMotion(): boolean {
  try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** Find the element `anchor` names inside `root`, open it when it is a
 * disclosure, scroll it into view and mark it. False when nothing here
 * carries that id. */
export function landOn(root: Element | null, anchor: string): boolean {
  const element = root?.querySelector<HTMLElement>(`[id="${anchor}"]`);
  if (!element) return false;
  if (element.tagName === "DETAILS") (element as HTMLDetailsElement).open = true;
  const target = element.tagName === "H2" ? element.closest("section") ?? element : element;
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  markElement(target);
  return true;
}
