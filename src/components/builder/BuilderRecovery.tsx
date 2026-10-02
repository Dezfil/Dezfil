"use client";
import { useState, type ComponentType } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { readApiError } from "../api";
import { fetchLayerRender, type LayerRenderData } from "./render-data";

export interface BuilderSeed { map: MapWithLayers; renders: Record<string, LayerRenderData> }
export interface BuilderRecoveryProps { recoverySeed?: BuilderSeed; onRecovered?: (seed: BuilderSeed) => void }
/** Read everything before discarding any draft. The new key retires all local controls. */
export async function readBuilderRecovery(mapId: string): Promise<BuilderSeed> {
  const response = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readApiError(response));
  const map = await response.json() as MapWithLayers;
  const entries = await Promise.all(map.layers.map(async layer => [layer.id, await fetchLayerRender(layer.id)] as const));
  return { map, renders: Object.fromEntries(entries) };
}
export function withBuilderRecovery<P extends object>(Editor: ComponentType<P & BuilderRecoveryProps>) {
  return function BuilderRecovery(props: P) {
    const [recovery, setRecovery] = useState<{ seed: BuilderSeed; version: number } | null>(null);
    return <Editor {...props} key={recovery?.version ?? 0} recoverySeed={recovery?.seed}
      onRecovered={seed => setRecovery(current => ({ seed, version: (current?.version ?? 0) + 1 }))} />;
  };
}
