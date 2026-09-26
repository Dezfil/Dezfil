"use client";

import type { LabelStyle, LayerStyle } from "@/lib/style/style";

import { LEGACY_HALO_COLOR } from "@/lib/style/style";

/** A fresh label (halo as width+color): plain
 * text, no halo — the halo is an opt-in for imagery and busy basemaps. */
const DEFAULT_LABEL: Omit<LabelStyle, "attribute"> = {
  size: 12,
  color: { r: 255, g: 255, b: 255, a: 1 },
  haloWidth: 0,
  haloColor: LEGACY_HALO_COLOR,
};

/**
 * The label on/off setters, extracted with fix: switching labels off
 * remembers the layer's authored size/color/halo so a comparison toggle
 * costs nothing — only the attribute choice resets. Per layer, in
 * memory, no new persistence. Attribute→attribute switches keep their
 * long-standing preservation.
 */
/** Module-level, so the memory survives the panel's own unmounts — tab
 * switches, collapse, layer changes — for the whole session (review
 * round one). Per layer id; never persisted. */
const remembered = new Map<string, Omit<LabelStyle, "attribute">>();

export function useLabelSetters(
  layerId: string,
  label: LabelStyle | undefined,
  patch: (partial: Partial<LayerStyle>) => void,
): {
  setLabelAttribute: (attribute: string) => void;
  setCellLabels: (on: boolean) => void;
} {
  const stash = () => {
    if (!label) return;
    // The COMPLETE authored configuration survives a toggle (plan:
    // remembering a subset would silently lose the new properties).
    const styling = { ...label };
    delete styling.attribute;
    remembered.set(layerId, styling);
  };
  /** Change the label source; styling survives an attribute switch. */
  const setLabelAttribute = (attribute: string) => {
    if (attribute === "") {
      stash();
      patch({ label: undefined });
    } else {
      patch({
        label: {
          ...DEFAULT_LABEL,
          ...(label ?? remembered.get(layerId)),
          attribute,
        },
      });
    }
  };
  /** Aggregated layers label their cells with the value — on or off. */
  const setCellLabels = (on: boolean) => {
    if (!on) stash();
    patch(
      on
        ? {
            label: {
              ...DEFAULT_LABEL,
              ...(label ?? remembered.get(layerId)),
              attribute: undefined,
            },
          }
        : { label: undefined },
    );
  };
  return { setLabelAttribute, setCellLabels };
}
