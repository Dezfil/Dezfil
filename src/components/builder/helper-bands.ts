import { DRAWER_GUTTER, DRAWER_WIDTH, OVERLAY_BELOW } from "./drawer/use-recipe-drawer";

/**
 * The builder's two helpers and the three width bands (positioning decision of
 * -09-04). Tools sits left of the stage, the assistant right of it, each the
 * drawer's width plus a gutter. Measured on the viewport, no setting:
 *
 *   at or below 1120     one helper at a time, overlaying its own side
 *   1121 to 1859         one at a time, docked; opening one replaces the other
 *   1860 and above       both docked; the map keeps at least 700 px
 *
 * The limit is the chrome three docked panes take (1160: the rail, the
 * inspector and its gutter, two helpers with their gutters, the screen's
 * right gutter) plus the 700 px map minimum, which governs the third
 * pane only.
 *
 * Narrowing out of the three-pane band with both open keeps the helper
 * opened later by hand and hides the other; widening back returns it.
 * The memory is passive: any hand action on either helper below the
 * limit forgets the hidden one. A hidden helper keeps its state; hiding
 * is not closing (D6), and the width never closes a helper by hand (D7).
 * Nothing here outlives a page: the assistant opens closed on every page
 * open and a click on its door opens it. Pure: the coordinator hook
 * wires it.
 */

export const HELPER_WIDTH = DRAWER_WIDTH;
export const HELPER_GUTTER = DRAWER_GUTTER;
/** What a docked helper moves its side's stage edge by. */
export const HELPER_OFFSET = HELPER_WIDTH + HELPER_GUTTER;
/** The chrome three docked panes take: 82 + 342 + 14 + 342 + 12 + 342 + 12 + 14. */
export const THREE_PANE_CHROME = 1160;
/** The map's minimum with both helpers docked (the third pane only). */
export const MAP_MINIMUM = 700;
/** From this viewport width both helpers dock. */
export const BOTH_FROM = THREE_PANE_CHROME + MAP_MINIMUM;

export type Band = "overlay" | "one" | "both";
export type Helper = "tools" | "assistant";

export function bandOf(width: number): Band {
  if (width <= OVERLAY_BELOW) return "overlay";
  if (width < BOTH_FROM) return "one";
  return "both";
}

/** The slot's state: what each helper's hand state is, which was opened
 * later by hand, and which one the width hid without closing it. */
export interface HelperSlot {
  tools: boolean;
  assistant: boolean;
  lastOpened: Helper | null;
  hidden: Helper | null;
}

export const CLOSED_SLOT: HelperSlot = { tools: false, assistant: false, lastOpened: null, hidden: null };

const other = (helper: Helper): Helper => (helper === "tools" ? "assistant" : "tools");

/** Whether a helper shows: open by hand and not hidden by the width. */
export function visible(slot: HelperSlot, helper: Helper): boolean {
  return slot[helper] && slot.hidden !== helper;
}

/** A hand open. Below the three-pane band it replaces the other helper
 * in one step; in that band both stay. Either way the hidden one is
 * forgotten: the memory is passive. */
export function openHelper(slot: HelperSlot, helper: Helper, band: Band): HelperSlot {
  return {
    tools: helper === "tools" ? true : band === "both" ? slot.tools : false,
    assistant: helper === "assistant" ? true : band === "both" ? slot.assistant : false,
    lastOpened: helper,
    hidden: null,
  };
}

/** A hand close. The hidden helper, if any, is forgotten, not shown. */
export function closeHelper(slot: HelperSlot, helper: Helper): HelperSlot {
  const rival = other(helper);
  return {
    ...slot,
    [helper]: false,
    [rival]: slot.hidden === rival ? false : slot[rival],
    hidden: null,
  } as HelperSlot;
}

/** The width crossed a band boundary. Leaving the three-pane band with
 * both open hides the helper opened earlier (with no hand order recorded
 * the assistant survives); entering it returns the hidden one. Any other
 * crossing changes nothing here: docking and overlaying are the edges'
 * business. */
export function crossBand(slot: HelperSlot, from: Band, to: Band): HelperSlot {
  if (from === "both" && to !== "both" && slot.tools && slot.assistant && slot.hidden === null) {
    const survivor = slot.lastOpened ?? "assistant";
    return { ...slot, hidden: other(survivor) };
  }
  if (from !== "both" && to === "both" && slot.hidden !== null) {
    return { ...slot, hidden: null };
  }
  return slot;
}

/** What each visible, docked helper adds to its side's stage edge; an
 * overlaying helper adds nothing, since the stage does not move for it. */
export function stageOffsets(slot: HelperSlot, band: Band): { left: number; right: number } {
  const docked = band !== "overlay";
  return {
    left: docked && visible(slot, "tools") ? HELPER_OFFSET : 0,
    right: docked && visible(slot, "assistant") ? HELPER_OFFSET : 0,
  };
}
