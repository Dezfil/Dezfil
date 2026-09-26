"use client";

import styles from "./Distribution.module.css";

/**
 * Distribution bars shared by the filter brush and the ramp control.
 * `highlight` lights the bars inside a selection — the filter's use;
 * `colorFor` paints each bar by the class its center falls into — the
 * ramp's use.
 */
export function DistributionBars({
  bins,
  from,
  to,
  highlight,
  colorFor,
}: {
  bins: number[];
  from: number;
  to: number;
  highlight?: [number, number];
  colorFor?: (center: number) => string | undefined;
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
              ...(colorFor ? { background: colorFor(center) } : null),
            }}
          />
        );
      })}
    </div>
  );
}
