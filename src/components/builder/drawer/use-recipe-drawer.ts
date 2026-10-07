"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * The tools drawer's own state.
 *
 * **The container is frozen at one width and these are its numbers.** 342 px —
 * the number, deliberately not "the inspector's width", which narrows to 306
 * px below the breakpoint — and a 12 px gutter to the stage. The snaps, the
 * drag handle, the 44 px collapse strip and the remembered width are withdrawn
 * by the one-step pivot: an adjustable width made the stage unpredictable, and
 * with no persistent chain to keep reachable the strip had nothing left to
 * keep.
 *
 * **What opening moves is the stage's left edge and nothing else.** Above the
 * shell's 1120 px breakpoint the drawer displaces the stage by adding its
 * width to the one property that defines the edge. At and below the
 * breakpoint it **overlays** instead, and publishes nothing — the map keeps
 * its full width beneath. A rail standing open beside the page moves that
 * breakpoint up by its shift; the helper slot (`helper-bands.ts`) decides.
 */

/** The one width, in CSS pixels. */
export const DRAWER_WIDTH = 342;
/** Between the drawer and the stage. */
export const DRAWER_GUTTER = 12;
/** The shell's one width breakpoint; below it the drawer overlays. */
export const OVERLAY_BELOW = 1120;

/**
 * What the drawer adds to the stage's left edge: zero when shut, zero in
 * overlay mode — the overlay's whole point is that the stage does not move —
 * and otherwise the one width plus the gutter.
 */
export function edgeOffset(state: { open: boolean; overlay: boolean }): number {
  if (!state.open || state.overlay) return 0;
  return DRAWER_WIDTH + DRAWER_GUTTER;
}

export interface RecipeDrawerState {
  open: boolean;
  /** The one width, published for the shell's style variable. Whether it
   * overlays the stage is the helper slot's to say: the band is one fact
   * for both helpers, moved by the open rail. */
  width: number;
  openDrawer: () => void;
  /**
   * The door: open with this layer's table pre-filled as the tool's input.
   *
   * The layer id is held rather than the layer, because what a run consumes
   * is a **snapshot** taken when it is authored — holding the layer itself
   * would invite re-reading it later, which is the one implementation that
   * rule forbids.
   */
  analyze: (layerId: string) => void;
  /** The layer the door arrived through, or null when it did not. */
  originLayerId: string | null;
  /**
   * The recipe behind the current action, once one exists.
   *
   * **Null is a real state, not a missing value.** Opening the drawer mints
   * nothing: the invisible one-step recipe is created at the first run, so a
   * user who opens, looks, and leaves has added nothing to the workspace.
   */
  recipeId: string | null;
  /** Open an existing recipe's action. */
  openRecipe: (recipeId: string) => void;
  /** Open with no layer behind it; the input can be any workspace table. */
  newRecipe: () => void;
  /** Remember the recipe the first run created, so a retry joins it. */
  bindRecipe: (recipeId: string) => void;
  /**
   * Close as the losing side of a pane replacement: the assistant is
   * taking the slot, and an ordinary close would yank focus back to this
   * drawer's opener over the control the user just pressed.
   */
  closeReplaced: () => void;
  /**
   * Which authoring session the drawer is in.
   *
   * **Binding a recipe is not the same as being pointed somewhere else.** The
   * contents reset when the user opens another action or presses *Analyze…*
   * on another layer; they must not reset when the first run of a draft
   * learns its own recipe's id — the run is still in flight at that moment,
   * and resetting discards the notice it is about to deliver.
   */
  session: number;
  close: () => void;
}

export function useRecipeDrawer(hooks?: {
  /** Fired as any door opens the drawer — the pane coordinator closes
   * the assistant here, in the same event, so the slot never blinks. */
  onOpen?: () => void;
}): RecipeDrawerState {
  const [open, setOpen] = useState(false);
  const [originLayerId, setOriginLayerId] = useState<string | null>(null);
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  /**
   * The control that opened the drawer, so closing — by any route, Escape
   * included — puts focus back where the user was. Captured at the moment
   * of opening rather than wired per door, so every door gets the behaviour
   * without knowing about it; a control that unmounted in the meantime is
   * skipped rather than focused blind.
   */
  const openerRef = useRef<HTMLElement | null>(null);
  const captureOpener = useCallback(() => {
    // Only when the drawer was closed: Run another tool re-opens a session
    // from *inside* the drawer, and capturing its own dying button would
    // leave Escape nowhere to return focus to. The
    // original door's capture stands.
    if (open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, [open]);

  // The callback, not the object: callers pass an inline literal, whose
  // identity changes every render; the callback they put in it does not.
  const onOpen = hooks?.onOpen;

  // The edge publication (one property, one writer) moved to the pane
  // coordinator in `host.tsx` when the assistant became a second occupant
  // of the slot — the offset is a fact about the slot, not about this
  // drawer alone.

  const close = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current;
    if (opener && opener.isConnected) opener.focus();
  }, []);

  return useMemo(
    () => ({
      open,
      width: DRAWER_WIDTH,
      openDrawer: () => {
        captureOpener();
        onOpen?.();
        setOpen(true);
      },
      analyze: (layerId: string) => {
        captureOpener();
        onOpen?.();
        setOriginLayerId(layerId);
        setRecipeId(null);
        setSession((n) => n + 1);
        setOpen(true);
      },
      originLayerId,
      recipeId,
      openRecipe: (id: string) => {
        captureOpener();
        onOpen?.();
        setRecipeId(id);
        setSession((n) => n + 1);
        // An existing action carries its own origin; the door's layer would
        // pre-fill an input it has nothing to do with.
        setOriginLayerId(null);
        setOpen(true);
      },
      newRecipe: () => {
        captureOpener();
        onOpen?.();
        setRecipeId(null);
        setOriginLayerId(null);
        setSession((n) => n + 1);
        setOpen(true);
      },
      bindRecipe: setRecipeId,
      closeReplaced: () => setOpen(false),
      session,
      close,
    }),
    [open, originLayerId, recipeId, session, close, captureOpener, onOpen],
  );
}
