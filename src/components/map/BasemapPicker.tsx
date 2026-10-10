"use client";

import { useCallback, useId, useRef, useState } from "react";
import { BASEMAPS, offeredOnly, type BasemapKey, type BasemapStyle } from "@/lib/basemap";
import { LayersIcon } from "../ui/icons";
import { popoverTriggerProps, usePopoverDismiss } from "../ui/Popover";
import { BasemapThumb } from "./BasemapThumb";
import { StageButton } from "./StageStack";
import styles from "./BasemapPicker.module.css";

/**
 * The published viewer's basemap picker. Auto plus the four styles as
 * cards, hung off a stage-stack button.
 *
 * The trigger is a button, never a tab: the published page asserts it
 * carries no builder chrome, and tab semantics here would be both a false
 * promise to assistive technology and a real regression of that guard.
 *
 * A pick lasts for the current page load only. Nothing is stored, so a
 * refresh returns every reader to the author's basemap — which is the
 * point of a shared link.
 */
export function BasemapPicker({
  active,
  custom = false,
  pinned,
  basemaps = BASEMAPS,
  onPick,
}: {
  /** The effective choice; null = Auto. */
  active: BasemapKey | null;
  /** The map's custom style is active: no card is marked —
   * the custom style is not a card, and switching away is one-way for
   * the load. */
  custom?: boolean;
  /** This deployment pins Auto in both themes. */
  pinned: boolean;
  /** The styles this instance draws, server-injected, each marked
   * offered or not: only an offered one is a card. Imagery is configured
   * rather than shipped, so it is a card only where it is configured. */
  basemaps?: BasemapStyle[];
  onPick: (key: BasemapKey | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  usePopoverDismiss({
    open,
    onClose: useCallback(() => setOpen(false), []),
    contentRef: panelRef,
    triggerRef,
  });

  const choose = (key: BasemapKey | null) => {
    onPick(key);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={styles.wrap}>
      <StageButton
        ref={triggerRef}
        action="Basemap"
        icon={<LayersIcon />}
        data-active={open || undefined}
        {...popoverTriggerProps(panelId, open)}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div id={panelId} ref={panelRef} className={styles.panel}>
          <p className={styles.title}>Basemap</p>
          <div className={styles.grid}>
            <button
              type="button"
              className={styles.card}
              aria-pressed={!custom && active === null}
              onClick={() => choose(null)}
            >
              <BasemapThumb style="auto" />
              <span className={styles.label}>Auto</span>
            </button>
            {offeredOnly(basemaps).map((b) => (
              <button
                key={b.key}
                type="button"
                className={styles.card}
                aria-pressed={!custom && b.key === active}
                onClick={() => choose(b.key)}
              >
                <BasemapThumb style={b.key} />
                <span className={styles.label}>{b.label}</span>
              </button>
            ))}
          </div>
          <p className={styles.note}>
            {custom
              ? "This map uses its own style. Picking a card replaces it " +
                "for this visit; reload to return."
              : active === null && pinned
                ? "Auto uses this instance's own style in both themes."
                : "Your choice lasts for this visit."}
          </p>
          {/* The previews are captures of the styles themselves, and the
              map's own footer only covers the style in use, so the picker
              carries its own line. */}
          <p className={styles.thumbCredit}>
            Previews: © OpenMapTiles, OpenStreetMap
          </p>
        </div>
      )}
    </div>
  );
}
