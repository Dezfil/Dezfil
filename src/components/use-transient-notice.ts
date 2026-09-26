"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a transient notice stays up — the import-whisper timing the
 * builder has used. */
const NOTICE_MS = 4000;

/**
 * A transient, self-clearing notice (extraction of the builder's
 * import-notice mechanics): `show` replaces the current text and
 * re-arms the timer; showing null clears immediately. The pending timer
 * is cleaned up on unmount.
 */
export function useTransientNotice(): {
  notice: string | null;
  show: (text: string | null) => void;
} {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string | null) => {
    setNotice(text);
    if (timer.current) window.clearTimeout(timer.current);
    if (text !== null) {
      timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
    }
  }, []);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return { notice, show };
}
