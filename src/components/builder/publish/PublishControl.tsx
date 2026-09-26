"use client";

import { useCallback, useRef, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import {
  popoverTriggerProps,
  usePopoverDismiss,
} from "@/components/ui/Popover";
import { PublishPopover } from "./PublishPopover";
import styles from "./PublishControl.module.css";

/**
 * The header's publish surface: the toolbar trigger and the popover it
 * owns, extracted from the header chrome. Dismissal is the kit's
 * popover contract: an outside pointer or Escape closes, the trigger is
 * excluded so its own click does not close and reopen, and Escape hands
 * focus back to it.
 */
export function PublishControl({
  map,
  onChange,
}: {
  map: MapWithLayers;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  usePopoverDismiss({
    open,
    onClose: useCallback(() => setOpen(false), []),
    contentRef: popRef,
    triggerRef,
  });

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        data-published={map.publishToken !== null}
        onClick={() => setOpen((o) => !o)}
        {...popoverTriggerProps("publish-popover", open)}
      >
        {map.publishToken ? "Published" : "Publish"}
      </button>
      {open && (
        <div id="publish-popover" ref={popRef} className={styles.pop}>
          <PublishPopover map={map} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
