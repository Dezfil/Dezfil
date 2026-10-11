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

/** Daylight kept between the pill and the basemap credit beside it. */
export const CREDIT_DAYLIGHT = 16;

type Extent = { left: number; right: number; top: number; bottom: number };

/**
 * The pill beside the basemap credit, both in the stage's bottom band.
 * The pill stays centred while it clears the credit; otherwise it slides
 * left in its band just far enough to keep daylight to the credit, and
 * never past the left edge its centred width cap allows. `room` is the
 * widest the pill may be there (Infinity while the two do not share the
 * band); `shift` is how far a pill `width` wide slides from centre.
 * `probe` is the pill's full permitted box, centred where the pill is.
 */
export function creditClearance(
  probe: Extent,
  credit: Extent | null,
  width: number,
  daylight: number = CREDIT_DAYLIGHT,
): { room: number; shift: number } {
  if (!credit || credit.top >= probe.bottom || probe.top >= credit.bottom) {
    return { room: Infinity, shift: 0 };
  }
  const center = (probe.left + probe.right) / 2;
  const end = credit.left - daylight;
  return {
    room: end - probe.left,
    shift: Math.max(0, center + width / 2 - end),
  };
}

export function useStatusPriority(
  present: readonly StatusKey[],
  /** The basemap credit the pill must keep clear of, when there is one. */
  credit: HTMLElement | null = null,
): {
  probeRef: (el: HTMLDivElement | null) => void;
  itemRef: (key: StatusKey) => (el: HTMLElement | null) => void;
  visible: readonly StatusKey[];
  /** How far the pill slides left of centre to clear the credit, in px. */
  shift: number;
} {
  const probeEl = useRef<HTMLDivElement | null>(null);
  const itemEls = useRef(new Map<StatusKey, HTMLElement>());
  const presentRef = useRef(present);
  const creditRef = useRef(credit);
  const [visible, setVisible] = useState<readonly StatusKey[]>(present);
  const [shift, setShift] = useState(0);

  // Keep the latest presence list where the measurement callbacks can
  // read it — written in a layout effect (declared before the recompute
  // effect below, so it is current when that one runs).
  useLayoutEffect(() => {
    presentRef.current = present;
    creditRef.current = credit;
  });

  const compute = useCallback(() => {
    const probe = probeEl.current;
    if (!probe) return;
    const style = window.getComputedStyle(probe);
    const padding =
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    const widths = new Map<StatusKey, number>();
    for (const [key, el] of itemEls.current) {
      widths.set(key, Math.ceil(el.getBoundingClientRect().width));
    }
    // Measured on the probe, which never slides: the choice and the
    // slide are functions of the stage and the credit, never of the
    // pill's own drawn position.
    const box = probe.getBoundingClientRect();
    const creditBox = creditRef.current?.getBoundingClientRect() ?? null;
    const { room } = creditClearance(box, creditBox, 0);
    const next = pickStatusItems(
      presentRef.current,
      widths,
      gap,
      Math.floor(Math.min(probe.clientWidth, room) - padding),
    );
    const width = next.length === 0 ? 0
      : next.reduce((sum, key) => sum + (widths.get(key) ?? 0), 0) + gap * (next.length - 1) + padding;
    setVisible((prev) =>
      prev.length === next.length && next.every((k, i) => prev[i] === k)
        ? prev
        : next,
    );
    setShift(Math.ceil(creditClearance(box, creditBox, width).shift));
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
      if (creditRef.current) ro.observe(creditRef.current);
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

  // The credit changes width with the basemap.
  useLayoutEffect(() => {
    if (!credit) return;
    observer.current?.observe(credit);
    return () => observer.current?.unobserve(credit);
  }, [credit]);

  // Re-pick after every commit: presence changes (pitch appearing, a
  // failed records readout) land here even when nothing resized.
  useLayoutEffect(compute);

  return { probeRef, itemRef, visible, shift };
}
