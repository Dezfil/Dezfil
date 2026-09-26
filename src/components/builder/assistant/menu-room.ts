import { useLayoutEffect, type RefObject } from "react";
import { ASSISTANT_PANE_SELECTOR } from "./escape-owner";

/**
 * How tall the picker's menu may stand (the effort rows fix).
 *
 * The menu opens upward from the chip and must stay inside the pane at
 * either width the picker supports, so its ceiling is the room between
 * the pane's top edge and the chip, less the gap the menu floats at and
 * an inset off the pane's border. The rule is pure so it can be walked
 * here; the hook below reads the two rectangles and hands the rule's
 * answer to the stylesheet, and the browser pass confirms which elements
 * those rectangles come from.
 */

/** The gap between the chip and the menu's bottom edge, as the stylesheet
 * floats it. */
export const MENU_GAP = 6;
/** The breathing room the menu keeps off the pane's top border. */
export const MENU_INSET = 8;

export function menuRoom(paneTop: number, anchorTop: number): number {
  return Math.max(0, Math.floor(anchorTop - paneTop - MENU_GAP - MENU_INSET));
}

/**
 * Hands the open menu its room: measured before its first paint and again
 * on a resize, written to the wrap as the `--menu-room` property the
 * stylesheet reads, and cleared when the menu closes. Where no pane holds
 * the picker nothing is written, and the stylesheet's own ceiling applies.
 * The name is spelled out at the write so the token check can credit it.
 */
export function useMenuRoom(anchor: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const element = anchor.current;
    const pane = element?.closest(ASSISTANT_PANE_SELECTOR);
    if (!open || !element || !pane) return;
    const measure = () => {
      const room = menuRoom(pane.getBoundingClientRect().top, element.getBoundingClientRect().top);
      element.style.setProperty("--menu-room", `${room}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      element.style.removeProperty("--menu-room");
    };
  }, [anchor, open]);
}
