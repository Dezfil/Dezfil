"use client";

import { useEffect } from "react";
import { drawnLabelTone } from "@/lib/basemap-effective";
import type { LabelTone } from "@/lib/style/label-recipe";
import { useCountFont, useLabelFont, type LabelFace } from "./label-font";

/** What a surface tells the canvas about its labels. */
export interface LabelSurface {
  /** This surface's label face: Inter, or Archivo on a published map. */
  face: LabelFace;
  /** The tone of the style the surface asks the canvas to draw. */
  tone: LabelTone;
  /** The surface's theme: the canvas's plain background takes its colour
   * where the style cannot load, and the labels its tone. */
  theme: "light" | "dark";
}

/**
 * The canvas's labels, out of the canvas under the decomposition rule: the
 * tone they are painted for, which is the tone of what the canvas actually
 * drew (only its basemap lifecycle knows the style failed and it drew its
 * plain background instead), and their faces once each may draw. The tone
 * is reported to the host whenever it changes, so whatever shows the
 * label's paint beside the map resolves it from the same tone.
 */
export function useLabelLook(
  surface: LabelSurface,
  offline: boolean,
  onTone?: (tone: LabelTone) => void,
): { tone: LabelTone; labelFont: string | null; countFont: string | null } {
  const tone = drawnLabelTone(surface.tone, surface.theme, offline);
  const labelFont = useLabelFont(surface.face);
  const countFont = useCountFont();
  useEffect(() => {
    onTone?.(tone);
  }, [tone, onTone]);
  return { tone, labelFont, countFont };
}
