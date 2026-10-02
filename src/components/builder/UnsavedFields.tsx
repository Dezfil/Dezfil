"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import styles from "./UnsavedFields.module.css";

const SavedContext = createContext<{ stale: boolean; saved: MapWithLayers | null }>({ stale: false, saved: null });
const LayerContext = createContext<Layer | null>(null);
export const BuilderSavedState = SavedContext.Provider;
export function LayerDraftFields({ layer, children }: { layer: Layer; children: ReactNode }) {
  return <LayerContext.Provider value={layer}>{children}</LayerContext.Provider>;
}
export function UnsavedMark({ children = "unsaved" }: { children?: ReactNode }) {
  return <span className={styles.mark} data-unsaved>{children}</span>;
}
export function UnsavedLayer({ layer, field }: { layer: Layer; field?: keyof Layer }) {
  const { stale, saved } = useContext(SavedContext);
  const before = saved?.layers.find(item => item.id === layer.id);
  return stale && JSON.stringify(field ? before?.[field] : before) !== JSON.stringify(field ? layer[field] : layer) ? <UnsavedMark /> : null;
}
const paths: Record<string, string[]> = {
  Radius: ["style.pointRadius", "style.pointRadiusBy", "viz.radiusPixels"], Width: ["style.strokeWidth", "style.strokeWidthBy"],
  Color: ["style.fill", "style.stroke", "style.strokeBy", "viz.fill"],
  Opacity: ["style.opacity"], Height: ["style.heightBy", "viz.elevation", "viz.height"],
  "Cell size": ["viz.cellKm"], Intensity: ["viz.intensity"],
};
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((result, key) => result && typeof result === "object" ? (result as Record<string, unknown>)[key] : undefined, value);
}
export function UnsavedField({ label }: { label: string }) {
  const layer = useContext(LayerContext);
  const { stale, saved } = useContext(SavedContext);
  const before = saved?.layers.find(item => item.id === layer?.id);
  return stale && layer && (paths[label] ?? []).some(path => JSON.stringify(at(before, path)) !== JSON.stringify(at(layer, path))) ? <UnsavedMark /> : null;
}

export function LegendUnsavedDot({ map, live }: { map: MapWithLayers; live: Record<string, { legendTitle?: string | null }> }) {
  const { stale, saved } = useContext(SavedContext);
  const changed = map.layers.some(layer => {
    const before = saved?.layers.find(item => item.id === layer.id);
    return (live[layer.id] ? live[layer.id].legendTitle : layer.legendTitle) !== before?.legendTitle;
  });
  return stale && changed ? <span className={styles.dot} role="img" aria-label="unsaved" data-unsaved /> : null;
}
