"use client";

import type { AreaSemantics } from "@/lib/overture/query";
import styles from "./AreaSemanticsToggle.module.css";

interface Props {
  value: AreaSemantics;
  onChange: (semantics: AreaSemantics) => void;
  /** Names what crosses the edge in this pane's data, e.g. "segments". */
  edgeNoun?: string;
  disabled?: boolean;
}

/**
 * The drawn-area semantics control: a visible two-way choice that doubles
 * as an explanation of how the query treats the shape. Shared by the
 * Overture and OSM panes.
 */
export function AreaSemanticsToggle({
  value,
  onChange,
  edgeNoun = "features",
  disabled,
}: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.seg} role="radiogroup" aria-label="Area semantics">
        <button
          type="button"
          role="radio"
          aria-checked={value === "within"}
          data-active={value === "within" || undefined}
          disabled={disabled}
          onClick={() => onChange("within")}
        >
          Entirely inside
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "intersect"}
          data-active={value === "intersect" || undefined}
          disabled={disabled}
          onClick={() => onChange("intersect")}
        >
          Touching the area
        </button>
      </div>
      {value === "intersect" && (
        <p className={styles.note}>
          {edgeNoun.charAt(0).toUpperCase() + edgeNoun.slice(1)} crossing the
          edge are included.
        </p>
      )}
    </div>
  );
}
