"use client";

import { useCallback, useState } from "react";

/**
 * The canvas lock: a way of looking, this page's alone. Locked, the
 * canvas makes no recipe or layout edit; every control that would carries
 * the one reason. Nothing is persisted and no API sees it, like full and
 * framed view; a reload starts unlocked.
 */

export const LOCK_REASON = "Canvas locked. Unlock to edit.";

export function useCanvasLock() {
  const [locked, setLocked] = useState(false);
  const toggle = useCallback(() => setLocked((v) => !v), []);
  const unlock = useCallback(() => setLocked(false), []);
  return { locked, toggle, unlock, reason: locked ? LOCK_REASON : null };
}
