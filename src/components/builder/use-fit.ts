"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Bounds } from "@/lib/geo-bounds";
import type { LiveDim } from "@/lib/live-filters";
import { effectiveExtent, mergeExtent } from "@/lib/map-extent";
import type { MapWithLayers } from "@/lib/metadata/maps";
import {
  extentLayers,
  fetchLayerExtent,
  type LayerRenderData,
} from "./render-data";

/**
 * The builder's fitting — kept beside MapBuilder rather than inside it,
 * per the decomposition rule.
 *
 * Fit measures what is DRAWN: the constraints the canvas is enforcing, the
 * selection-specific geometry where one is drawn, and — for the whole-map
 * fit — only the layers the author has shown. An extent the browser cannot
 * know, which means a tiled layer under a constraint, is asked of the
 * server.
 *
 * Two rules keep it honest. A superseded answer never moves the camera: a
 * scrub can outrun its own request, and applying a stale extent would jump
 * the map to a frame the user has already left behind. And a failure
 * leaves the camera alone rather than falling back to the unconstrained
 * extent — framing data the user filtered away is the defect this exists
 * to remove, so doing it on failure would defeat the feature.
 */
export function useFit({
  rendersRef,
  serverMapRef,
  dims,
  staged,
  cameraRef,
  setFitBounds,
  fail,
  clearFailure,
}: {
  rendersRef: React.RefObject<Record<string, LayerRenderData>>;
  serverMapRef: React.RefObject<MapWithLayers | null>;
  /** The constraints the canvas is enforcing, per layer. */
  dims: Record<string, LiveDim[]>;
  /** The selection-specific renders currently drawn, per layer. */
  staged: Record<string, LayerRenderData | undefined>;
  /** The canvas's live ranges, read at press time: a slider drag and the
   * timeline's playhead move them imperatively, so the settled dims a host
   * holds can be behind what is actually drawn. */
  cameraRef: React.RefObject<{ liveRanges: () => Record<string, [number, number][]> } | null>;
  setFitBounds: (bounds: Bounds) => void;
  fail: (lane: "fit", message: string) => void;
  /** Clears the lane: a standing fit failure is false the moment a later
   * fit succeeds. */
  clearFailure: (lane: "fit") => void;
}): { fitAll: () => void; fitLayer: (layerId: string) => void } {
  const seqRef = useRef(0);
  // Fitting is defined where the host can call it, above where the canvas
  // state it needs is computed; the refs carry that state across without
  // making every fit callback change identity on every render.
  const dimsRef = useRef(dims);
  const stagedRef = useRef(staged);
  useEffect(() => {
    dimsRef.current = dims;
    stagedRef.current = staged;
  }, [dims, staged]);

  const run = useCallback(
    async (only?: string[]) => {
      const seq = ++seqRef.current;
      const layers = extentLayers(rendersRef.current, {
        // The explicit per-layer action works on a hidden layer exactly as
        // it did: asking for one layer is not the same as framing the map.
        visible: only
          ? () => true
          : (id) =>
              serverMapRef.current?.layers.find((l) => l.id === id)?.visible ??
              true,
        staged: stagedRef.current,
        dims: dimsRef.current,
        only,
      });
      // Overlay what the canvas is enforcing right now over the settled
      // dims, in dimension order — the same order the canvas stores them.
      const live = cameraRef.current?.liveRanges() ?? {};
      const current = layers.map((l) => {
        const ranges = live[l.id];
        if (!ranges) return l;
        return {
          ...l,
          dims: l.dims.map((d, i) =>
            ranges[i] ? { ...d, range: ranges[i] } : d,
          ),
        };
      });
      const local = effectiveExtent(current);
      // The constraints as they stand at the moment of asking. An answer
      // is only applied if they still stand when it arrives: a press is
      // not the only thing that can invalidate a request in flight — a
      // scrub or a widget brush during it changes what the answer means.
      const asked = JSON.stringify(current.map((l) => [l.id, l.dims]));
      const stale = () =>
        seq !== seqRef.current ||
        JSON.stringify(
          extentLayers(rendersRef.current, {
            visible: () => true,
            staged: stagedRef.current,
            dims: dimsRef.current,
            only: current.map((l) => l.id),
          }).map((l) => {
            const ranges = (cameraRef.current?.liveRanges() ?? {})[l.id];
            return [
              l.id,
              ranges
                ? l.dims.map((d, i) => (ranges[i] ? { ...d, range: ranges[i] } : d))
                : l.dims,
            ];
          }),
        ) !== asked;
      let bounds = local.bounds;
      for (const id of local.deferred) {
        const answer = await fetchLayerExtent(
          id,
          current.find((l) => l.id === id)?.dims ?? [],
        );
        if (stale()) return;
        if (!answer.ok) {
          fail("fit", answer.message);
          return;
        }
        bounds = mergeExtent(bounds, answer.box);
      }
      if (stale()) return;
      clearFailure("fit");
      // Nothing drawn is a normal outcome of filtering, not a failure: the
      // camera simply stays where it is.
      if (bounds) setFitBounds([...bounds] as Bounds);
    },
    [
      rendersRef,
      serverMapRef,
      cameraRef,
      setFitBounds,
      fail,
      clearFailure,
    ],
  );

  return {
    fitAll: useCallback(() => void run(), [run]),
    fitLayer: useCallback((layerId: string) => void run([layerId]), [run]),
  };
}
