"use client";

import { useEffect, useState } from "react";
import type { Corner } from "@/lib/corners";

export type LegendPlacement = {
  docked: boolean;
  /** Docked legends fill the rail card column; standalone legends keep
 * the content-fit width ruled on. */
  width: "rail" | "fit";
  /** Bottom-right starts docked until its exact element pair is measured. */
  measured: boolean;
};

/** The placement decision without DOM concerns. `bottomRightHasRoom` is
 * deliberately optional: an unmeasured bottom-right legend docks, the
 * arrangement that cannot overlap the widget rail. */
export function legendPlacement(
  corner: Corner,
  widgetsVisible: boolean,
  bottomRightHasRoom?: boolean,
): LegendPlacement {
  const needsMeasurement = widgetsVisible && corner === "bottom-right";
  const docked =
    widgetsVisible &&
    (corner === "top-right" ||
      (corner === "bottom-right" && bottomRightHasRoom !== true));
  return {
    docked,
    width: docked ? "rail" : "fit",
    measured: !needsMeasurement || bottomRightHasRoom !== undefined,
  };
}

/** Whether the bottom-right candidate fits below the rendered end of the
 * widgets-only stack, leaving the same gap the rail uses between cards.
 * The candidate is bottom-anchored at its real corner, so its `top`
 * already incorporates its standalone height and every host-specific
 * bottom inset or lift. */
export function bottomRightRoom(
  widgets: { bottom: number },
  standaloneLegend: { top: number },
  gap: number,
): boolean {
  return widgets.bottom + gap <= standaloneLegend.top;
}

type Measured = {
  widgets: HTMLElement;
  legend: HTMLElement;
  geometryKey: unknown;
  room: boolean;
};

function renderedRailGap(widgets: HTMLElement): number {
  const rail = widgets.parentElement;
  if (!rail) return 0;
  const style = getComputedStyle(rail);
  const layoutGap = parseFloat(style.rowGap || style.gap) || 0;
  const scale = rail.offsetWidth
    ? rail.getBoundingClientRect().width / rail.offsetWidth
    : 1;
  return layoutGap * (Number.isFinite(scale) ? scale : 1);
}

/** Shared builder/viewer/export legend placement. The measured elements
 * are intentionally independent of the decision: `widgets` never includes
 * the docked legend, and `standaloneLegend` remains laid out at the real
 * bottom-right corner while docked (hidden and inert in the host). */
export function useLegendPlacement(
  corner: Corner,
  widgetsVisible: boolean,
  widgets: HTMLElement | null,
  standaloneLegend: HTMLElement | null,
  geometryKey: unknown = null,
): LegendPlacement {
  const [measured, setMeasured] = useState<Measured | null>(null);
  const needsMeasurement = widgetsVisible && corner === "bottom-right";

  useEffect(() => {
    if (!needsMeasurement || !widgets || !standaloneLegend) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const room = bottomRightRoom(
        widgets.getBoundingClientRect(),
        standaloneLegend.getBoundingClientRect(),
        renderedRailGap(widgets),
      );
      setMeasured((current) =>
        current?.widgets === widgets &&
        current.legend === standaloneLegend &&
        current.geometryKey === geometryKey &&
        current.room === room
          ? current
          : { widgets, legend: standaloneLegend, geometryKey, room },
      );
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    queue();

    const ro = new ResizeObserver(queue);
    ro.observe(widgets);
    ro.observe(standaloneLegend);
    // Parent sizes move both anchors without necessarily resizing their
    // contents (canvas resize, fullscreen, export shape/step changes).
    if (widgets.parentElement) ro.observe(widgets.parentElement);
    if (standaloneLegend.parentElement) {
      ro.observe(standaloneLegend.parentElement);
    }
    window.addEventListener("resize", queue);

    // The builder/viewer offsets and export scales animate. ResizeObserver
    // sees their boxes, not their changing positions, so settle once more
    // when either host finishes a transition.
    const widgetHost = widgets.parentElement ?? widgets;
    const legendHost = standaloneLegend.parentElement ?? standaloneLegend;
    widgetHost.addEventListener("transitionend", queue, true);
    legendHost.addEventListener("transitionend", queue, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", queue);
      widgetHost.removeEventListener("transitionend", queue, true);
      legendHost.removeEventListener("transitionend", queue, true);
    };
  }, [needsMeasurement, widgets, standaloneLegend, geometryKey]);

  const room =
    measured?.widgets === widgets &&
    measured.legend === standaloneLegend &&
    measured.geometryKey === geometryKey
      ? measured.room
      : undefined;
  return legendPlacement(corner, widgetsVisible, room);
}
