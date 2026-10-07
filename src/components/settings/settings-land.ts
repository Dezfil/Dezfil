/**
 * Landing on a row: the element an address names is brought into view
 * under the header and marked for a moment, so the eye finds it. A
 * disclosure it names opens (the shipped password link opens Change
 * password); a card's heading marks the whole card.
 */

import { createContext, useContext, useEffect } from "react";

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

/**
 * A tab that draws from a read tells the frame once its rows are on the
 * page, so an address or a search hit naming one of them lands when the
 * row arrives rather than before.
 */
export const DrawnContext = createContext<(() => void) | null>(null);

/** Report the tab's rows drawn while `ready` holds. */
export function useDrawn(ready: boolean): void {
  const drawn = useContext(DrawnContext);
  useEffect(() => { if (ready) drawn?.(); }, [ready, drawn]);
}

/** Mark an element outside the page's content (the header's theme
 * button) with the same wash, drawn on the element itself. */
export function markOutside(target: HTMLElement): void {
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  const style = target.style;
  style.setProperty("background-color", "var(--accent-wash)");
  style.setProperty("box-shadow", "0 0 0 4px var(--accent-wash)");
  markElement(target);
  setTimeout(() => {
    style.setProperty("transition", "background-color var(--dur-feedback) ease, box-shadow var(--dur-feedback) ease");
    style.removeProperty("background-color");
    style.removeProperty("box-shadow");
    setTimeout(() => style.removeProperty("transition"), MARK_FADE_MS);
  }, MARK_HOLD_MS);
}
