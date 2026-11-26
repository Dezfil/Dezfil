"use client";

import { createContext, useContext, useState } from "react";
import type { LabelTone } from "@/lib/style/label-recipe";

/**
 * The tone the builder's labels are painted for, as its canvas actually drew
 * it, handed down to whatever shows a label's paint beside the map, so the
 * Label section resolves an automatic label's colours from the same tone as
 * the map. Absent a builder above it, a reader takes the light tone.
 */
export const LabelToneContext = createContext<LabelTone>("light");

/** The tone the builder's labels are painted for. */
export function useLabelTone(): LabelTone {
  return useContext(LabelToneContext);
}

/**
 * The builder's record of what its canvas reported: the tone it last
 * painted labels for, or null before its first report. The setter is the
 * canvas's report channel.
 */
export function useReportedLabelTone(): [LabelTone | null, (tone: LabelTone) => void] {
  return useState<LabelTone | null>(null);
}

/** The tone the builder provides: what the canvas reported, or, before it
 * has, the tone of the style the builder asked it to draw. */
export function builderLabelTone(reported: LabelTone | null, requested: LabelTone): LabelTone {
  return reported ?? requested;
}
