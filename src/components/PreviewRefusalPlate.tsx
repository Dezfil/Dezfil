"use client";

import { GeoPinIcon, InfoIcon } from "./ui/icons";
import styles from "./TablePreviewMap.module.css";

/**
 * The preview map's refusal, stated on its own plate, extracted from the
 * table preview map at its touch: the sentence is the API's, and on a No
 * geometry dataset the plate carries the Set geometry door (01 A3) when
 * the page hands one in.
 */
export function PreviewRefusalPlate({ reason, onSetGeometry }: { reason?: string; onSetGeometry?: () => void }) {
  return (
    <div className={styles.notice} data-preview-refusal="">
      <p className={styles.refusal}>
        <InfoIcon />
        <span>{reason}</span>
        {onSetGeometry && (
          <button type="button" className={styles.door} onClick={onSetGeometry} data-set-geometry-door="plate">
            <GeoPinIcon />
            Set geometry
          </button>
        )}
      </p>
    </div>
  );
}
