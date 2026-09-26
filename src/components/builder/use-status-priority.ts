"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Status-bar priority sizing. The bar drops items whole, lowest priority
// first, when width runs out — never clipping mid-item. Capacity and
// item widths are measured from an invisible probe row that always holds
// every present item at natural size, so the chosen subset is a pure
// function of independent inputs and can never feed back on its own
// reduced rendering.

export type StatusKey = "records" | "coords" | "zoom" | "pitch" | "bbox";

/** Keep-priority: coords survives
 * last; pitch drops first. */
const KEEP_PRIORITY: readonly StatusKey[] = [
  "coords",
  "zoom",
  "records",
  "bbox",
  "pitch",
];

/**
 * The largest priority-prefix of the present items whose natural widths,
 * with gaps, fit the capacity. A missing measurement ends the prefix —
 * survivors are always contiguous in priority, never skipped past.
 */
export function pickStatusItems(
  present: readonly StatusKey[],
  widths: ReadonlyMap<StatusKey, number>,
  gap: number,
  capacity: number,
): StatusKey[] {
  const kept: StatusKey[] = [];
  let used = 0;
  for (const key of KEEP_PRIORITY) {
    if (!present.includes(key)) continue;
    const width = widths.get(key);
    if (width === undefined) break;
    const next = kept.length === 0 ? width : used + gap + width;
    if (next > capacity) break;
    kept.push(key);
    used = next;
  }
  return kept;
}

export function useStatusPriority(present: readonly StatusKey[]): {
  probeRef: (el: HTMLDivElement | null) => void;
  itemRef: (key: StatusKey) => (el: HTMLElement | null) => void;
  visible: readonly StatusKey[];
} {
  const probeEl = useRef<HTMLDivElement | null>(null);
  const itemEls = useRef(new Map<StatusKey, HTMLElement>());
  const presentRef = useRef(present);
  const [visible, setVisible] = useState<readonly StatusKey[]>(present);

  // Keep the latest presence list where the measurement callbacks can
  // read it — written in a layout effect (declared before the recompute
  // effect below, so it is current when that one runs).
  useLayoutEffect(() => {
    presentRef.current = present;
  });

  const compute = useCallback(() => {
    const probe = probeEl.current;
    if (!probe) return;
    const style = window.getComputedStyle(probe);
    const capacity =
      probe.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    const widths = new Map<StatusKey, number>();
    for (const [key, el] of itemEls.current) {
      widths.set(key, Math.ceil(el.getBoundingClientRect().width));
    }
    const next = pickStatusItems(
      presentRef.current,
      widths,
      gap,
      Math.floor(capacity),
    );
    setVisible((prev) =>
      prev.length === next.length && next.every((k, i) => prev[i] === k)
        ? prev
        : next,
    );
  }, []);

  const observer = useRef<ResizeObserver | null>(null);

  const probeRef = useCallback(
    (el: HTMLDivElement | null) => {
      probeEl.current = el;
      observer.current?.disconnect();
      if (!el) return;
      const ro = new ResizeObserver(compute);
      observer.current = ro;
      ro.observe(el);
      for (const item of itemEls.current.values()) ro.observe(item);
      compute();
    },
    [compute],
  );

  // One stable callback per key — a fresh closure each render would make
  // React detach and reattach every item ref on every commit.
  const refCallbacks = useRef(
    new Map<StatusKey, (el: HTMLElement | null) => void>(),
  );
  const itemRef = useCallback((key: StatusKey) => {
    let cb = refCallbacks.current.get(key);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const map = itemEls.current;
        if (el) {
          map.set(key, el);
          observer.current?.observe(el);
        } else {
          const prev = map.get(key);
          if (prev) observer.current?.unobserve(prev);
          map.delete(key);
        }
      };
      refCallbacks.current.set(key, cb);
    }
    return cb;
  }, []);

  // Re-pick after every commit: presence changes (pitch appearing, a
  // failed records readout) land here even when nothing resized.
  useLayoutEffect(compute);

  return { probeRef, itemRef, visible };
}
