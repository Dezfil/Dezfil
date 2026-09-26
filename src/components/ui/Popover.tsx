"use client";

import { useEffect, type RefObject } from "react";

/** The non-menu floating surface.
 *
 * A popover is not a menu: its content is a panel a user works inside, not
 * a list of commands, so it claims no menu semantics and takes no roving
 * focus. What it does owe is the part the app's two popovers each
 * re-derived: a trigger that states the relationship, Escape and an
 * outside pointer that dismiss, and — on a keyboard dismissal — focus
 * handed back to the trigger rather than dropped on the document.
 *
 * A hook and a props helper rather than a wrapper component, because a
 * popover's trigger and its panel are not always siblings here — the
 * assistant's toggle lives in the stage stack and its panel is a fixed
 * card at the other end of the tree. */
export function usePopoverDismiss({
  open,
  onClose,
  contentRef,
  triggerRef,
  alsoInside,
}: {
  open: boolean;
  onClose: () => void;
  contentRef: RefObject<HTMLElement | null>;
  /** Excluded from the outside-pointer test, so the trigger's own click
   * does not close and immediately reopen; it also receives focus back
   * after Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * What else counts as inside, though it is not a DOM descendant.
   *
   * A popover that contains a **menu** needs this: the kit's menu portals
   * its items to the document, so a pointer on one reads as outside, the
   * popover closes, and the item is unmounted before the click that was
   * activating it completes. The item then does nothing at all — which is
   * how the recipe index's whole overflow (Rename, Duplicate, Delete)
   * became unreachable while looking perfectly clickable.
   */
  alsoInside?: (target: Element) => boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node;
      if (
        contentRef.current?.contains(node) ||
        triggerRef?.current?.contains(node)
      )
        return;
      if (node instanceof Element && alsoInside?.(node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Consumed: an outer surface must not also dismiss on this press.
      e.preventDefault();
      onClose();
      // Escape may fire with focus inside the panel, which is about to be
      // hidden: hand focus back so keyboard navigation continues.
      triggerRef?.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, contentRef, triggerRef, alsoInside]);
}

/** What a popover trigger must say. `id` is the panel's.
 *
 * No `aria-haspopup`: neither panel is a dialog, a menu or a listbox, and
 * naming a popup type that does not appear tells assistive technology
 * something untrue. The relationship a reader needs — this control owns
 * that region, and it is open or closed — is carried without it. */
export function popoverTriggerProps(id: string, open: boolean) {
  return {
    "aria-expanded": open,
    "aria-controls": id,
  };
}
