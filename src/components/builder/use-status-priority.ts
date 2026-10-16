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

/** Daylight kept between the pill and the corner furniture beside it: the
 * basemap credit and a lower-right legend card on its right, a lower-left
 * legend card on its left. */
export const CREDIT_DAYLIGHT = 16;

type Extent = { left: number; right: number; top: number; bottom: number };

/**
 * The pill between the basemap credit and a lower-left legend card, all
 * three in the stage's bottom band, and clear of a lower-right legend card
 * whose foot reaches into the band above the credit, counted on the right
 * as the credit is. The pill stays centred while it clears them; otherwise
 * it slides in its band just far enough to keep daylight to the one it
 * would cover, and never past the edges its centred width cap allows.
 * `room` is the widest the pill may be there (Infinity while none shares
 * the band); `shift` is how far a pill `width` wide slides from centre,
 * left positive. `probe` is the pill's full permitted box, centred where
 * the pill is.
 */
export function creditClearance(
  probe: Extent,
  credit: Extent | null,
  width: number,
  legend: Extent | null = null,
  legendRight: Extent | null = null,
  daylight: number = CREDIT_DAYLIGHT,
): { room: number; shift: number } {
  const shares = (box: Extent | null): box is Extent =>
    !!box && box.top < probe.bottom && probe.top < box.bottom;
  // The nearer of the right-hand furniture in the band ends the room.
  const rightEdges = [credit, legendRight].filter(shares).map((box) => box.left - daylight);
  const right = rightEdges.length > 0 ? Math.min(...rightEdges) : null;
  const left = shares(legend) ? Math.max(probe.left, legend.right + daylight) : null;
  if (right === null && left === null) return { room: Infinity, shift: 0 };
  const center = (probe.left + probe.right) / 2;
  const start = left ?? probe.left;
  // Alone, the credit's room is capped by the caller against the probe's
  // own width; beside a legend the pill may not run past the cap either.
  const end = right === null ? probe.right
    : left === null ? right
    : Math.min(right, probe.right);
  // Where both would bind, the credit wins, as it did alone; the room
  // keeps that from arising for any pill that is drawn.
  const over = center + width / 2 - end;
  const under = start - (center - width / 2);
  return {
    room: end - start,
    shift: over > 0 ? over : under > 0 ? -under : 0,
  };
}

export function useStatusPriority(
  present: readonly StatusKey[],
  /** The basemap credit the pill must keep clear of, when there is one. */
  credit: HTMLElement | null = null,
  /** The lower-left legend corner, which the pill keeps clear of too. */
  legend: HTMLElement | null = null,
  /** The lower-right legend corner, above the credit: kept clear of too. */
  legendRight: HTMLElement | null = null,
): {
  probeRef: (el: HTMLDivElement | null) => void;
  itemRef: (key: StatusKey) => (el: HTMLElement | null) => void;
  visible: readonly StatusKey[];
  /** How far the pill slides from centre to clear the credit and the
   * legend, in px: positive to the left, negative to the right. */
  shift: number;
} {
  const probeEl = useRef<HTMLDivElement | null>(null);
  const itemEls = useRef(new Map<StatusKey, HTMLElement>());
  const presentRef = useRef(present);
  const creditRef = useRef(credit);
  const legendRef = useRef(legend);
  const legendRightRef = useRef(legendRight);
  const [visible, setVisible] = useState<readonly StatusKey[]>(present);
  const [shift, setShift] = useState(0);

  // Keep the latest presence list where the measurement callbacks can
  // read it — written in a layout effect (declared before the recompute
  // effect below, so it is current when that one runs).
  useLayoutEffect(() => {
    presentRef.current = present;
    creditRef.current = credit;
    legendRef.current = legend;
    legendRightRef.current = legendRight;
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
    // slide are functions of the stage, the credit and the legend, never
    // of the pill's own drawn position.
    const box = probe.getBoundingClientRect();
    const creditBox = creditRef.current?.getBoundingClientRect() ?? null;
    const legendBox = legendRef.current?.getBoundingClientRect() ?? null;
    // A legend docked in the rail leaves a hidden copy in its corner for
    // placement; nothing is drawn there.
    const right = legendRightRef.current;
    const rightBox = right && !right.hasAttribute("data-legend-placement-probe")
      ? right.getBoundingClientRect() : null;
    const { room } = creditClearance(box, creditBox, 0, legendBox, rightBox);
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
    // Rounded away from centre, so the pill never stops short of daylight.
    const slide = creditClearance(box, creditBox, width, legendBox, rightBox).shift;
    setShift(slide < 0 ? Math.floor(slide) : Math.ceil(slide));
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
      if (legendRef.current) ro.observe(legendRef.current);
      if (legendRightRef.current) ro.observe(legendRightRef.current);
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

  // The legend opens, closes and refits its card; its corner also glides
  // (fullscreen moves it past the inspector, a docked timeline lifts it),
  // which no resize reports, so the end of a glide re-measures too.
  useLayoutEffect(() => {
    const corners = [legend, legendRight].filter((el): el is HTMLElement => el !== null);
    for (const corner of corners) {
      observer.current?.observe(corner);
      corner.addEventListener("transitionend", compute);
    }
    return () => {
      for (const corner of corners) {
        observer.current?.unobserve(corner);
        corner.removeEventListener("transitionend", compute);
      }
    };
  }, [legend, legendRight, compute]);

  // Re-pick after every commit: presence changes (pitch appearing, a
  // failed records readout) land here even when nothing resized.
  useLayoutEffect(compute);

  return { probeRef, itemRef, visible, shift };
}
