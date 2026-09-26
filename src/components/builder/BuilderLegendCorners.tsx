"use client";

import type { Dispatch, SetStateAction } from "react";
import { CORNERS, type Corner } from "@/lib/corners";
import {
  LegendPanel,
  type LegendTextTarget,
  type NamedStyle,
} from "../map/LegendPanel";
import { CornerDrag } from "./CornerDrag";
import styles from "./MapBuilder.module.css";

/** The builder's standalone legend corners and drag quadrants. Extracted
 * from MapBuilder at the docking fix's touch boundary; the rail host stays
 * with the dashboard it configures. */
export function BuilderLegendCorners({
  legendCorner,
  legendDocked,
  legendLayers,
  dragPreview,
  onPreview,
  onDrop,
  onTextClick,
  onLabelEdit,
  bottomLeftRef,
  bottomRightRef,
  cornerLift,
  creditLift,
  statusPillHidden,
}: {
  legendCorner: Corner;
  legendDocked: boolean;
  legendLayers: NamedStyle[];
  dragPreview: Corner | null;
  onPreview: Dispatch<SetStateAction<Corner | null>>;
  onDrop: (corner: Corner) => void;
  onTextClick: (target: LegendTextTarget) => void;
  onLabelEdit: (layerId: string, slot: number, value: string | null) => void;
  bottomLeftRef: (node: HTMLElement | null) => void;
  bottomRightRef: (node: HTMLElement | null) => void;
  cornerLift: boolean;
  creditLift: boolean;
  statusPillHidden: boolean;
}) {
  return (
    <>
      {CORNERS.map((corner) => {
        // A docked bottom-right legend keeps an inert standalone copy in
        // its exact corner, independent of the visible rail child.
        const placementProbe =
          legendCorner === "bottom-right" &&
          corner === "bottom-right" &&
          legendDocked;
        const hasLegend =
          legendCorner === corner && (!legendDocked || placementProbe);
        if (!hasLegend) return null;
        const bottom = corner === "bottom-left" || corner === "bottom-right";
        return (
          <div
            key={corner}
            className={styles.overlayCorner}
            data-corner={corner}
            data-legend-placement-probe={placementProbe || undefined}
            ref={
              corner === "bottom-right"
                ? bottomRightRef
                : bottom
                  ? bottomLeftRef
                  : undefined
            }
            aria-hidden={placementProbe || undefined}
            inert={placementProbe || undefined}
            style={placementProbe ? { visibility: "hidden" } : undefined}
            data-lift={
              // A lifted credit occupies the band the grounded right
              // legend can grow into; couple only that visible placement.
              bottom &&
              (cornerLift ||
                (creditLift &&
                  statusPillHidden &&
                  corner === "bottom-right"))
                ? ""
                : undefined
            }
          >
            <CornerDrag
              corner={corner}
              onPreview={onPreview}
              onDrop={onDrop}
            >
              <LegendPanel
                layers={legendLayers}
                onTextClick={onTextClick}
                onLabelEdit={onLabelEdit}
              />
            </CornerDrag>
          </div>
        );
      })}
      {dragPreview && (
        <div className={styles.dropZones} aria-hidden>
          {CORNERS.map((corner) => (
            <div
              key={corner}
              className={styles.dropZone}
              data-corner={corner}
              data-active={corner === dragPreview}
            />
          ))}
        </div>
      )}
    </>
  );
}
