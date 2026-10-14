"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a transient notice stays up — the import-whisper timing the
 * builder has used. */
const NOTICE_MS = 4000;

/** How a notice reads: a plain success, or a warning or failure in the
 * failure note's tones. */
export type NoticeTone = "ok" | "warn" | "danger";

/**
 * A transient, self-clearing notice (extraction of the builder's
 * import-notice mechanics): `show` replaces the current text and
 * re-arms the timer; showing null clears immediately. A warning or a
 * failure stays until it is dismissed or replaced: it may be the only
 * account of what went wrong. The pending timer is cleaned up on unmount.
 */
export function useTransientNotice(): {
  notice: string | null;
  tone: NoticeTone;
  show: (text: string | null, tone?: NoticeTone) => void;
} {
  const [shown, setShown] = useState<{ notice: string | null; tone: NoticeTone }>({ notice: null, tone: "ok" });
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string | null, tone: NoticeTone = "ok") => {
    setShown({ notice: text, tone });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (text !== null && tone === "ok") {
      timer.current = window.setTimeout(() => setShown({ notice: null, tone: "ok" }), NOTICE_MS);
    }
  }, []);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return { notice: shown.notice, tone: shown.tone, show };
}
