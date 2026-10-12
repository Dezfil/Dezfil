import type { BasemapKey } from "@/lib/basemap";

/** Each basemap's ground, water and roads, read off its capture: the
 * colours a small map drawn on the Settings page takes, as data. */
export const SAMPLE_GROUNDS: Readonly<Record<BasemapKey, { readonly land: string; readonly water: string; readonly road: string }>> = {
  light: { land: "#f2f3f0", water: "#c3cacc", road: "#ffffff" },
  dark: { land: "#0e0e0e", water: "#1b1a1e", road: "#232323" },
  streets: { land: "#f8f4f0", water: "#9fbdff", road: "#ffffff" },
  satellite: { land: "#3f4a33", water: "#06101f", road: "#7b786b" },
};
