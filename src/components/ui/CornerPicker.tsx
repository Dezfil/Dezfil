"use client";

import type { Corner } from "@/lib/corners";
import { ChoiceGroup, type Choice } from "./ChoiceGroup";
import styles from "./CornerPicker.module.css";

/**
 * Choosing a corner looks like picking the thumbnail that matches (map
 * proxy at field ruling): a 2×2 of tiles, each a small map with its
 * corner pip, the chosen tile accented. Visual reference: variant D
 * ("Quadrant tiles") of Radio semantics come from the kit's ChoiceGroup
 * — one tab stop, arrow movement in reading order, disabled corners
 * skipped — so this component owns only the look.
 */

const CORNER_NAMES: Record<Corner, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};

/** Reading order: the arrow keys walk the corners the way text reads. */
const READING_ORDER: readonly Corner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export function CornerPicker({
  label,
  value,
  onChange,
  disabledCorners,
}: {
  label: string;
  value: Corner;
  onChange: (next: Corner) => void;
  /** Corners that cannot be chosen, keyed to the reason they cannot. */
  disabledCorners?: Partial<Record<Corner, string>>;
}) {
  const choices: Choice<Corner>[] = READING_ORDER.map((corner) => ({
    value: corner,
    name: CORNER_NAMES[corner],
    label: <span className={styles.pip} data-corner={corner} aria-hidden />,
    disabled: disabledCorners?.[corner] !== undefined,
    title: disabledCorners?.[corner],
  }));
  return (
    <ChoiceGroup
      label={label}
      value={value}
      onChange={onChange}
      choices={choices}
      className={styles.frame}
      itemClassName={styles.corner}
    />
  );
}
