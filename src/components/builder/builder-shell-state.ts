"use client";

import type { AggregatedViz, ClusterViz, OdViz } from "@/lib/viz";
import type { LayerStyle } from "@/lib/style/style";
import type { TabSpec } from "@/components/ui/Tabs";
import { createPreferenceStore } from "./preference-store";

/**
 * The builder shell's own state: which inspector tab is showing, and the
 * per-browser preferences the chrome remembers.
 *
 * Extracted from `MapBuilder.tsx` under the decomposition rule, by the change
 * that made the stage's left edge one property. It is the piece that change
 * works on: the shell's chrome, its remembered preferences, and — next — the
 * drawer's own snap width, which the contract says must widen this store
 * rather than be encoded as a pair of booleans or open a new persistence
 * mechanism for one value.
 *
 * Nothing here changes behaviour. The stores keep their keys, and a store is
 * still one singleton per key.
 */

export type RailTab = "layers" | "basemap" | "widgets" | "legend";

export const RAIL_TABS: readonly TabSpec<RailTab>[] = [
  { value: "layers", label: "Layers" },
  { value: "basemap", label: "Basemap" },
  { value: "widgets", label: "Widgets" },
  { value: "legend", label: "Legend" },
];

/** Status pill visibility: a builder overlay, not map content — only
 * "hidden" is stored; unset means visible. */
export const statusPillStore = createPreferenceStore("dezfil-status-pill-hidden");

/** A style or viz edit in flight, before it is written to the layer. */
export interface AppearanceDraft {
  style?: LayerStyle;
  viz?: AggregatedViz | OdViz | ClusterViz;
}
