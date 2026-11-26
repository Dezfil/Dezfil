"use client";

import type { ComponentProps } from "react";
import { LABEL_HALO_WIDTH_MAX, type LabelPaintChoice, type LabelStyle } from "@/lib/style/style";
import { labelPaint } from "@/lib/style/label-paint";
import { useLabelTone } from "../label-tone";
import { ColorRow, SliderRow } from "./rows";
import own from "./LabelSection.module.css";

type SliderHandlers = Pick<ComponentProps<typeof SliderRow>, "onChange" | "onPreview" | "onCommit">;

/**
 * The Label section's paint: Color, Halo width and Halo color. Each row
 * shows the paint the map draws, resolved for the tone the builder's canvas
 * reported, and says "Automatic" while its part follows the map; a part of
 * the label's own offers the way back instead.
 *
 * The text is one part and the halo another, its width and colour
 * together: a change to either makes the whole halo the label's own, the
 * member left alone starting from the value its row showed, so nothing
 * jumps on a dark map (the stored fallback is the light recipe's).
 */
export function LabelPaintRows({
  label,
  set,
  sliderHandlers,
}: {
  label: LabelStyle;
  /** Write these members over the label. */
  set: (partial: Partial<LabelStyle>) => void;
  /** The halo width slider's change, preview and commit, each writing
   * `extra` beside the width. */
  sliderHandlers: (key: "haloWidth", extra: Partial<LabelStyle>) => SliderHandlers;
}) {
  const paint = labelPaint(label, useLabelTone());
  const ownHalo: Partial<LabelStyle> = { haloPaint: "own", haloWidth: paint.haloWidth, haloColor: paint.haloColor };
  const textChoice = (
    <PaintChoice choice={label.textPaint} name="Label color" onAutomatic={() => set({ textPaint: "automatic" })} />
  );
  const haloChoice = (name: string) => (
    <PaintChoice choice={label.haloPaint} name={name} onAutomatic={() => set({ haloPaint: "automatic" })} />
  );
  return (
    <>
      <ColorRow
        label="Color"
        name="Label color"
        color={paint.color}
        onChange={(color) => set({ color, textPaint: "own" })}
        after={textChoice}
      />
      <SliderRow
        label="Halo width"
        value={paint.haloWidth}
        min={0}
        max={LABEL_HALO_WIDTH_MAX}
        step={0.05}
        {...sliderHandlers("haloWidth", ownHalo)}
        after={haloChoice("Halo width")}
      />
      <ColorRow
        label="Halo color"
        name="Label halo color"
        color={paint.haloColor}
        onChange={(haloColor) => set({ ...ownHalo, haloColor })}
        after={haloChoice("Label halo color")}
      />
    </>
  );
}

/** "Automatic" as a word while the part follows the map; while it is the
 * label's own, the way back to it. */
function PaintChoice({
  choice,
  name,
  onAutomatic,
}: {
  choice: LabelPaintChoice | undefined;
  /** The row's control, which names the way back. */
  name: string;
  onAutomatic: () => void;
}) {
  return choice === "automatic" ? (
    <span className={own.paintChoice} data-paint-choice="automatic">Automatic</span>
  ) : (
    <button
      type="button"
      className={own.paintBack}
      data-paint-choice="own"
      aria-label={`${name} back to Automatic`}
      onClick={onAutomatic}
    >
      Automatic
    </button>
  );
}
