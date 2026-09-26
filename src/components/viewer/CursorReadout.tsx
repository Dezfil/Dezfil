"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { formatReaderCoords, type StatusChannel } from "@/lib/map-status";
import { createHeldCursor } from "@/lib/held-cursor";
import { hasFinePointer } from "@/lib/pointer";
import styles from "./CursorReadout.module.css";

const FLASH_MS = 1400;

/**
 * The published view's cursor readout: "lat, lng" in the attribution
 * strip — latitude first, the reader order, deliberately diverging from
 * the builder's SQL order — with precision tracking zoom. Clicking
 * copies the displayed string with a quiet in-place confirmation. The
 * held-cursor store keeps the reading alive while the pointer crosses
 * from the canvas onto the button, so the click can land. Renders
 * nothing off-map once the hold lapses, and nothing at all on a device
 * with no fine pointer.
 */
export function CursorReadout({ channel }: { channel: StatusChannel }) {
  const [fine] = useState(
    () => typeof window !== "undefined" && hasFinePointer(),
  );
  // The store's channel subscription is made inside attach — the path
  // useSyncExternalStore re-runs on a Strict-Mode remount — never in
  // the memo factory, whose cleanup would sever it for good.
  const store = useMemo(() => createHeldCursor(channel), [channel]);
  const status = useSyncExternalStore(store.attach, store.get, () => null);
  const [flash, setFlash] = useState<"ok" | "failed" | null>(null);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const copy = useCallback(async (text: string) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false;
    }
    setFlash(ok ? "ok" : "failed");
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  if (!fine || !status?.cursor) return null;
  const text = formatReaderCoords(status.cursor, status.zoom);

  return (
    <button
      className={styles.readout}
      title="Copy coordinates"
      onPointerEnter={() => store.setHovered(true)}
      onPointerLeave={() => store.setHovered(false)}
      onClick={(event) => {
        // The strip sits above the canvas; stopping propagation keeps
        // the copy click from reaching anything underneath regardless.
        event.stopPropagation();
        void copy(text);
      }}
    >
      {flash ? (
        <span
          className={styles.flash}
          data-ok={flash === "ok" ? "" : undefined}
        >
          {flash === "ok" ? "copied" : "couldn't copy"}
        </span>
      ) : (
        text
      )}
    </button>
  );
}
