/**
 * Landing on a row: the element an address names is brought into view
 * under the header and marked for a moment, so the eye finds it. A
 * disclosure it names opens (the shipped password link opens Change
 * password); a card's heading marks the whole card.
 */

import { createContext, useContext, useEffect } from "react";
import type { SettingsTabId } from "./settings-tabs";

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

/** How long a tab may take to read before it shows in its own loading
 * state, and how long a page with nothing to show stays blank. */
export const PENDING_DELAY_MS = 300;

/** What the frame hears from a tab in its pane. */
export interface TabSlotEvents {
  /** Every first read of the tab has landed (or it reads nothing). */
  ready(slot: TabSlot): void;
  /** A part of the tab has drawn its rows. */
  drawn(slot: TabSlot): void;
}

let slots = 0;

/**
 * A tab in the frame's pane. A tab opening beside the one on screen
 * mounts out of sight, and each part of it that draws from a read holds
 * it there until that read has landed; once nothing holds it, it is ready
 * to take the other's place whole. A tab with nothing to read is ready as
 * soon as it has mounted.
 */
export class TabSlot {
  readonly id = ++slots;
  private holds = 0;
  private mounted = false;
  private told = false;
  constructor(readonly tab: SettingsTabId, private readonly events: TabSlotEvents) {}

  /** A part of the tab draws from a read that has not landed. */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.check();
    };
  }

  drawn(): void { this.events.drawn(this); }

  /** Every part of the tab has mounted, and held what it reads. */
  mount(): void {
    this.mounted = true;
    this.check();
  }

  /** The tab has left the pane: it is never ready. */
  unmount(): void {
    this.mounted = false;
  }

  private check(): void {
    // After every effect of the step that let a read go: a part that
    // mounts in that step, and reads in its turn, holds the tab first.
    queueMicrotask(() => {
      if (!this.mounted || this.told || this.holds) return;
      this.told = true;
      this.events.ready(this);
    });
  }
}

/**
 * A tab that draws from a read holds its slot out of sight until the read
 * has landed, then tells the frame its rows are on the page, so an
 * address or a search hit naming one of them lands once they are, and the
 * tab is on screen.
 */
export const DrawnContext = createContext<TabSlot | null>(null);

/** Hold the tab while `ready` is false; report its rows drawn once it holds. */
export function useDrawn(ready: boolean): void {
  const slot = useContext(DrawnContext);
  useEffect(() => {
    if (!slot) return;
    if (ready) { slot.drawn(); return; }
    return slot.hold();
  }, [ready, slot]);
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
