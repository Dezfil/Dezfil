import { INSET_HEIGHT, INSET_WIDTH, WORLD_LAND, insetPoint } from "./world-outline";
import styles from "./WorldInset.module.css";

/** The world inset at the map's top right: the whole world with a
 * marker where the fit sits, so a swapped pair says "the Somali coast"
 * before any label does. */
export function WorldInset({ center }: { center: readonly [number, number] }) {
  const [cx, cy] = insetPoint(center);
  return (
    <svg
      className={styles.inset}
      viewBox={`0 0 ${INSET_WIDTH} ${INSET_HEIGHT}`}
      width={INSET_WIDTH}
      height={INSET_HEIGHT}
      aria-hidden="true"
      data-world-inset=""
      data-inset-center={`${center[0]},${center[1]}`}
    >
      <rect className={styles.water} x="0" y="0" width={INSET_WIDTH} height={INSET_HEIGHT} rx="6" />
      {WORLD_LAND.map((ring, i) => (
        <polygon key={i} className={styles.land} points={ring.map((p) => insetPoint(p).map((v) => v.toFixed(1)).join(",")).join(" ")} />
      ))}
      <circle className={styles.marker} cx={cx.toFixed(1)} cy={cy.toFixed(1)} r="4" data-inset-marker="" />
    </svg>
  );
}
