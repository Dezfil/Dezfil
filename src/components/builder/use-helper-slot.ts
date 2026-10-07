"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RecipeDrawerState } from "./drawer/use-recipe-drawer";
import {
  closeHelper,
  crossBand,
  openHelper,
  stageOffsets,
  visible,
  type Band,
  type Helper,
  type HelperSlot,
} from "./helper-bands";
import { useViewportBand } from "./use-viewport-band";

/**
 * The two-sided helper slot's coordinator: the pure rules in
 * `helper-bands.ts`, wired to the drawer's own open state, the
 * assistant's open state and the viewport's band. It publishes both
 * stage edges together, as one commit, and moves focus out of a helper
 * the width is about to hide.
 *
 * Who owns what: the drawer owns Tools' hand state (its doors, its
 * focus return, its session); this hook owns the assistant's hand state,
 * written by hand actions only (D7), and which helper was opened later
 * by hand and which one the width hid, and applies the slot's
 * transitions to those owners.
 *
 * The assistant's hand state is this mount's and nothing else: the map
 * opens with the pane closed however the last one was left, and a click
 * on the door opens it. Nothing is stored,
 * so the server snapshot and the first client render agree.
 */

export const ASSISTANT_DOOR_SELECTOR = '[aria-controls="builder-assistant"]';
export const TOOLS_DOOR_SELECTOR = "[data-tools-control]";
const TOOLS_SELECTOR = "[data-recipe-drawer]";
const ASSISTANT_SELECTOR = "[data-assistant-pane]";

/** Focus inside the helper the width is about to hide lands on its door. */
function moveFocusToDoor(helper: Helper) {
  const surface = document.querySelector(helper === "tools" ? TOOLS_SELECTOR : ASSISTANT_SELECTOR);
  if (!surface?.contains(document.activeElement)) return;
  document.querySelector<HTMLElement>(helper === "tools" ? TOOLS_DOOR_SELECTOR : ASSISTANT_DOOR_SELECTOR)?.focus();
}

export interface HelperSlotControl {
  band: Band;
  /** True in the overlay band, where a helper overlays: at and below the
   * shell's breakpoint, moved up by the open rail. Both helpers read it. */
  overlay: boolean;
  toolsVisible: boolean;
  assistantVisible: boolean;
  /** Both edges' offsets, published together. */
  offsets: { left: number; right: number };
  /** Changes once per open, close, replacement or crossing: the commit key. */
  committedAt: string;
  openAssistant: () => void;
  closeAssistant: () => void;
  toggleAssistant: () => void;
}

interface Memory { lastOpened: Helper | null; hidden: Helper | null; band: Band }

export function useHelperSlot(drawer: RecipeDrawerState, onToolsOpenedRef: React.RefObject<(() => void) | null>): HelperSlotControl {
  // The rail's width is inside the bands' chrome, so Always open moves
  // both limits with it.
  const band = useViewportBand();
  const [assistantHand, setAssistantHand] = useState(false);
  const [memory, setMemory] = useState<Memory>({ lastOpened: null, hidden: null, band });

  // The crossing is applied during render, never a frame later: the
  // band changed, so the slot the offsets are computed from must already
  // be the crossed one before anything paints.
  let current = memory;
  if (memory.band !== band) {
    const crossed = crossBand({ tools: drawer.open, assistant: assistantHand, lastOpened: memory.lastOpened, hidden: memory.hidden }, memory.band, band);
    current = { lastOpened: crossed.lastOpened, hidden: crossed.hidden, band };
    setMemory(current);
  }
  const slot: HelperSlot = { tools: drawer.open, assistant: assistantHand, lastOpened: current.lastOpened, hidden: current.hidden };
  // Hand actions read the slot as it stands at the event, never a stale
  // closure: the refs follow every committed render.
  const slotRef = useRef(slot);
  const bandRef = useRef(band);
  useLayoutEffect(() => {
    slotRef.current = slot;
    bandRef.current = band;
  });

  // A helper the width hid: focus leaves it for its door, and the
  // crossing frame carries no transition.
  const hiddenBefore = useRef<Helper | null>(null);
  useLayoutEffect(() => {
    const hidden = current.hidden;
    if (hidden !== hiddenBefore.current) {
      if (hidden) moveFocusToDoor(hidden);
      document.body.setAttribute("data-helper-swap", "");
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => document.body.removeAttribute("data-helper-swap")));
      hiddenBefore.current = hidden;
      return () => cancelAnimationFrame(raf);
    }
    hiddenBefore.current = hidden;
  }, [current.hidden]);

  // The drawer's doors: a hand open of Tools. Below the limit it replaces
  // the assistant, a hand action that closes it, as the replacement did
  // before the pane moved right.
  useLayoutEffect(() => {
    onToolsOpenedRef.current = () => {
      const next = openHelper(slotRef.current, "tools", bandRef.current);
      if (!next.assistant && slotRef.current.assistant) setAssistantHand(false);
      setMemory((m) => ({ ...m, lastOpened: "tools", hidden: null }));
    };
  }, [onToolsOpenedRef]);

  // The drawer's hand close, observed on its falling edge: the hidden
  // assistant, if any, is forgotten (the memory is passive).
  const toolsWasOpen = useRef(drawer.open);
  useEffect(() => {
    if (toolsWasOpen.current && !drawer.open) {
      const next = closeHelper(slotRef.current, "tools");
      if (!next.assistant && slotRef.current.assistant) setAssistantHand(false);
      setMemory((m) => (m.hidden === null ? m : { ...m, hidden: null }));
    }
    toolsWasOpen.current = drawer.open;
  }, [drawer.open]);

  const openAssistant = useCallback(() => {
    const next = openHelper(slotRef.current, "assistant", bandRef.current);
    if (!next.tools && slotRef.current.tools) drawer.closeReplaced();
    setAssistantHand(true);
    setMemory((m) => ({ ...m, lastOpened: "assistant", hidden: null }));
  }, [drawer]);
  const closeAssistant = useCallback(() => {
    const next = closeHelper(slotRef.current, "assistant");
    if (!next.tools && slotRef.current.tools) drawer.closeReplaced();
    setAssistantHand(false);
    setMemory((m) => (m.hidden === null ? m : { ...m, hidden: null }));
  }, [drawer]);
  const assistantVisible = visible(slot, "assistant");
  const toggleAssistant = useCallback(() => {
    if (visible(slotRef.current, "assistant")) closeAssistant(); else openAssistant();
  }, [closeAssistant, openAssistant]);

  const offsets = stageOffsets(slot, band);
  // **Both edges, one writer, one commit.** The two custom properties are
  // written together, in a layout effect so the crossing frame already
  // shows the final geometry and no transition can start from the old one.
  useLayoutEffect(() => {
    document.body.style.setProperty("--drawer-offset", `${offsets.left}px`);
    document.body.style.setProperty("--assistant-offset", `${offsets.right}px`);
  }, [offsets.left, offsets.right]);
  useEffect(() => () => {
    document.body.style.removeProperty("--drawer-offset");
    document.body.style.removeProperty("--assistant-offset");
  }, []);

  return {
    band,
    overlay: band === "overlay",
    toolsVisible: visible(slot, "tools"),
    assistantVisible,
    offsets,
    committedAt: `${offsets.left}:${offsets.right}`,
    openAssistant,
    closeAssistant,
    toggleAssistant,
  };
}
