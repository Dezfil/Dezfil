"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLayerRender } from "./render-data";
import { RenderOrder, type Renders } from "./render-order";

/** Ask again for every listed layer's render, as one replacement: the
 * answers, or null when it was cancelled or a later replacement overtook
 * it. A seed answers for the layers it holds without a request. */
export type ReplaceRenders = (
  layerIds: readonly string[],
  options?: { seed?: Renders; cancelled?: () => boolean },
) => Promise<Renders | null>;

/**
 * The builder's render answers, kept beside MapBuilder instead of inside it:
 * the shown set, the three ways it changes (one layer asks again, the whole
 * map is replaced, a layer leaves) and the tile poll. Every write passes the
 * one ordering rule in render-order.ts, and nothing else can write: the set
 * is returned for reading only.
 */
export function useLayerRenders() {
  const order = useMemo(() => new RenderOrder(), []);
  const [renders, setRenders] = useState<Renders>({});
  const rendersRef = useRef<Renders>({});
  const show = useCallback((next: Renders) => {
    if (next === rendersRef.current) return;
    rendersRef.current = next;
    setRenders(next);
  }, []);

  const refreshLayer = useCallback(async (layerId: string) => {
    const ticket = order.request(layerId);
    const data = await fetchLayerRender(layerId);
    const next = order.answer(rendersRef.current, layerId, ticket, data);
    if (next) show(next);
  }, [order, show]);

  const replaceRenders = useCallback<ReplaceRenders>(async (layerIds, options = {}) => {
    const begun = order.replace(rendersRef.current, layerIds);
    show(begun.shown);
    const entries = await Promise.all(
      layerIds.map(async (id) => [id, options.seed?.[id] ?? await fetchLayerRender(id)] as const),
    );
    if (options.cancelled?.()) return null;
    const answers: Renders = Object.fromEntries(entries);
    const next = order.settle(rendersRef.current, begun.ticket, answers);
    if (!next) return null;
    show(next);
    return answers;
  }, [order, show]);

  const removeRender = useCallback((layerId: string) => {
    show(order.remove(rendersRef.current, layerId));
  }, [order, show]);

  // Tiles prepare in the background: poll a preparing layer's render
  // until it settles into ready (drawn) or failed (errored state).
  useEffect(() => {
    const preparing = Object.values(renders)
      .filter((r) => r.ok && r.tiles?.state === "building")
      .map((r) => r.layerId);
    if (preparing.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of preparing) void refreshLayer(id);
    }, 2500);
    return () => clearTimeout(timer);
  }, [renders, refreshLayer]);

  const shown: { readonly current: Readonly<Renders> } = rendersRef;
  return { renders, rendersRef: shown, refreshLayer, replaceRenders, removeRender };
}
