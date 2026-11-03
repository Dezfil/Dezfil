"use client";

import styles from "./Distribution.module.css";

/**
 * Distribution bars shared by the filter brush and the ramp controls.
 * `highlight` lights the bars inside a selection — the filter's use;
 * `colorFor` paints each bar by its linear center — the continuous ramp's
 * use; `barColors` paints each bar as given — the classed brush, which
 * colours its bars from the bins' own edges on its own axis.
 */
export function DistributionBars({
  bins,
  from,
  to,
  highlight,
  colorFor,
  barColors,
}: {
  bins: number[];
  from: number;
  to: number;
  highlight?: [number, number];
  colorFor?: (center: number) => string | undefined;
  barColors?: (string | undefined)[];
}) {
  const max = Math.max(...bins, 1);
  const span = to - from || 1;
  return (
    <div className={styles.bars} aria-hidden>
      {bins.map((n, i) => {
        const center = from + ((i + 0.5) / bins.length) * span;
        return (
          <i
            key={i}
            className={styles.bar}
            data-in={
              highlight
                ? center >= highlight[0] && center <= highlight[1]
                : undefined
            }
            style={{
              height: `${Math.max((n / max) * 100, n > 0 ? 4 : 0)}%`,
              ...(barColors
                ? { background: barColors[i] }
                : colorFor
                  ? { background: colorFor(center) }
                  : null),
            }}
          />
        );
      })}
    </div>
  );
}
