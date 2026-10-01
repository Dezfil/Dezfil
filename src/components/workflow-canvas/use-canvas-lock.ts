"use client";

import { useCallback, useState } from "react";
import { useViewOnly, VIEW_ONLY_REASON } from "./view-only";

/**
 * The canvas lock: a way of looking, this page's alone. Locked, the
 * canvas makes no recipe or layout edit; every control that would carries
 * the one reason. Nothing is persisted and no API sees it, like full and
 * framed view; a reload starts unlocked.
 */

export const LOCK_REASON = "Canvas locked. Unlock to edit.";

/** The lock as the page holds it: a view-only page is locked for good,
 * with the API's refusal as its reason and nothing that toggles it; any
 * other page locks and unlocks at the person's word. */
export function canvasLock(viewOnly: boolean, locked: boolean) {
  if (viewOnly) return { locked: true, reason: VIEW_ONLY_REASON, canToggle: false };
  return { locked, reason: locked ? LOCK_REASON : null, canToggle: true };
}

export function useCanvasLock() {
  const viewOnly = useViewOnly();
  const [chosen, setLocked] = useState(false);
  const { locked, reason, canToggle } = canvasLock(viewOnly, chosen);
  const toggle = useCallback(() => {
    if (canToggle) setLocked((v) => !v);
  }, [canToggle]);
  const unlock = useCallback(() => {
    if (canToggle) setLocked(false);
  }, [canToggle]);
  return { locked, toggle, unlock, reason };
}
