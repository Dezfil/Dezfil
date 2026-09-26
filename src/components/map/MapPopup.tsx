"use client";

import { XIcon } from "../ui/icons";
import styles from "./MapCanvas.module.css";

/** The canvas's feature read-outs, out of the map monolith
 * (the at-touch decomposition slice): the follow-the-pointer tooltip
 * and the pinned pop-up share one row presentation; the pop-up adds a
 * drawn close — the glyph class is banned in chrome. */

interface FeatureReadout {
  x: number;
  y: number;
  entries: [string, unknown][];
}

function Rows({ entries }: { entries: [string, unknown][] }) {
  return (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className={styles.tipRow}>
          <span className={styles.tipKey}>{k}</span>
          <span className={styles.tipVal}>{String(v)}</span>
        </div>
      ))}
    </>
  );
}

export function MapTooltip({ hover }: { hover: FeatureReadout | null }) {
  if (!hover) return null;
  return (
    <div
      className={styles.tooltip}
      style={{ left: hover.x + 14, top: hover.y + 14 }}
    >
      <Rows entries={hover.entries} />
    </div>
  );
}

export function MapPopup({
  pinned,
  onClose,
}: {
  pinned: FeatureReadout | null;
  onClose: () => void;
}) {
  if (!pinned) return null;
  return (
    <div className={styles.popup} style={{ left: pinned.x, top: pinned.y }}>
      <button
        className={styles.popupClose}
        onClick={onClose}
        aria-label="Close pop-up"
      >
        <XIcon />
      </button>
      <Rows entries={pinned.entries} />
    </div>
  );
}
