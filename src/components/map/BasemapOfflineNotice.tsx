import styles from "./MapCanvas.module.css";

/**
 * The basemap-failure chip (extracted from MapCanvas): shown while
 * tiles cannot load, anchored inside the visible window at top center —
 * the corners belong to the hosts' own chrome. The wrap spans the whole
 * viewport in the builder, so the builder's padding recenters the chip
 * on the visible map.
 */
export function BasemapOfflineNotice({
  customBasemap,
  padding,
}: {
  customBasemap: boolean;
  padding?: { top: number; right: number; bottom: number; left: number };
}) {
  return (
    <div
      className={styles.offline}
      style={
        padding
          ? {
              top: padding.top + 12,
              left: `calc(50% + ${(padding.left - padding.right) / 2}px)`,
            }
          : undefined
      }
    >
      {customBasemap
        ? "this map's basemap didn't load · data only"
        : "basemap offline · data only"}
    </div>
  );
}
