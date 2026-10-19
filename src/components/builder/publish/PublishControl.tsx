"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import {
  popoverTriggerProps,
  usePopoverDismiss,
} from "@/components/ui/Popover";
import { PublishPopover } from "./PublishPopover";
import styles from "./PublishControl.module.css";

/** How far above the window's bottom edge the panel stops. */
const EDGE = 12;

/** The tallest the panel may be: from where it starts down to the
 * window's bottom edge, less the margin. */
export function panelMaxHeight(panelTop: number, windowHeight: number): number {
  return Math.max(0, Math.floor(windowHeight - panelTop - EDGE));
}

/**
 * The header's publish surface: the toolbar trigger and the popover it
 * owns, extracted from the header chrome. Dismissal is the kit's
 * popover contract: an outside pointer or Escape closes, the trigger is
 * excluded so its own click does not close and reopen, and Escape hands
 * focus back to it. The open panel is bounded to the room below its
 * anchor, so a long list inside it scrolls rather than running off the
 * window.
 */
export function PublishControl({
  map,
  onChange,
}: {
  map: MapWithLayers;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  usePopoverDismiss({
    open,
    onClose: useCallback(() => setOpen(false), []),
    contentRef: popRef,
    triggerRef,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const wrap = wrapRef.current;
      const pop = popRef.current;
      if (!wrap || !pop) return;
      // The panel's top from its offset, which its rise-in transform
      // does not move.
      const top = wrap.getBoundingClientRect().top + pop.offsetTop;
      setMaxHeight(panelMaxHeight(top, window.innerHeight));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        data-published={map.published}
        onClick={() => setOpen((o) => !o)}
        {...popoverTriggerProps("publish-popover", open)}
      >
        {map.published ? "Published" : "Publish"}
      </button>
      {open && (
        <div
          id="publish-popover"
          ref={popRef}
          className={styles.pop}
          style={maxHeight === null ? undefined : { maxHeight }}
        >
          <PublishPopover map={map} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
