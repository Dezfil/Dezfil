"use client";

import { ChoiceGroup } from "./ui/ChoiceGroup";
import styles from "./QueryAreaPicker.module.css";

/**
 * The two-level Query Area selector, shared by the Overture and OSM
 * panes: a category row (Polygon / BBox / Boundaries) over a
 * subcategory row. Picking a category lands on its first subcategory.
 */

export type QueryAreaMode =
  | "draw"
  | "layer"
  | "view"
  | "rect"
  | "country"
  | "state"
  | "city";

interface Category {
  key: string;
  label: string;
  subs: { key: QueryAreaMode; label: string }[];
  /** Landed on when the category is picked; first sub otherwise. */
  defaultSub?: QueryAreaMode;
}

const POLYGON: Category = {
  key: "polygon",
  label: "Polygon",
  subs: [
    { key: "draw", label: "Draw" },
    { key: "layer", label: "Select from Layer" },
  ],
};

const BBOX: Category = {
  key: "bbox",
  label: "BBox",
  subs: [
    { key: "view", label: "Current View" },
    { key: "rect", label: "Rectangle" },
  ],
  // Rectangle is the useful default.
  defaultSub: "rect",
};

const BOUNDARIES: Category = {
  key: "boundaries",
  label: "Boundaries",
  subs: [
    { key: "country", label: "Country" },
    { key: "state", label: "State" },
    { key: "city", label: "City" },
  ],
};

interface Props {
  value: QueryAreaMode;
  onChange: (mode: QueryAreaMode) => void;
  /** Overture offers named boundaries; OSM does not. */
  boundaries?: boolean;
}

export function QueryAreaPicker({ value, onChange, boundaries }: Props) {
  const categories = boundaries ? [POLYGON, BBOX, BOUNDARIES] : [POLYGON, BBOX];
  const active =
    categories.find((c) => c.subs.some((s) => s.key === value)) ?? categories[0];
  return (
    <div className={styles.picker}>
      <ChoiceGroup
        label="Query area kind"
        className={styles.cats}
        style={{ gridTemplateColumns: `repeat(${categories.length}, 1fr)` }}
        value={active.key}
        onChange={(key) => {
          const picked = categories.find((c) => c.key === key);
          if (picked && active.key !== key)
            onChange(picked.defaultSub ?? picked.subs[0].key);
        }}
        choices={categories.map((c) => ({ value: c.key, label: c.label }))}
      />
      <ChoiceGroup
        label={`${active.label} mode`}
        className={styles.subs}
        style={{ gridTemplateColumns: `repeat(${active.subs.length}, 1fr)` }}
        value={value}
        onChange={onChange}
        choices={active.subs.map((sub) => ({
          value: sub.key,
          label: sub.label,
        }))}
      />
    </div>
  );
}

export default QueryAreaPicker;
