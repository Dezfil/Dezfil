"use client";

import { useCallback, useState } from "react";
import type { FillPaint, SizeScale } from "@/lib/style/style";
import { readApiError } from "../../api";
import type { ClassifyRequest } from "./PaintControls";

/**
 * The style panel's server-side styling channels: classify a paint,
 * resolve a size scale — and own the one failure state both write, so
 * the panel renders it without holding it.
 */
export function useStyleChannels(layerId: string): {
  busy: boolean;
  channelError: string | null;
  dismissChannelError: () => void;
  classify: (req: ClassifyRequest) => Promise<FillPaint | null>;
  resolveScale: (
    attribute: string,
    range: [number, number],
    unit?: "px" | "m",
  ) => Promise<SizeScale | null>;
} {
  const [busy, setBusy] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  /** Classify a paint server-side (fill or outline). */
  const classify = useCallback(
    async (req: ClassifyRequest): Promise<FillPaint | null> => {
      setBusy(true);
      setChannelError(null);
      try {
        const response = await fetch(`/api/layers/${layerId}/fill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        });
        if (response.ok) return (await response.json()) as FillPaint;
        setChannelError(await readApiError(response));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [layerId],
  );

  /** Resolve a size scale's domain server-side (meters for the extrusion
   * channel). */
  const resolveScale = useCallback(
    async (
      attribute: string,
      range: [number, number],
      unit: "px" | "m" = "px",
    ): Promise<SizeScale | null> => {
      setBusy(true);
      setChannelError(null);
      try {
        const response = await fetch(`/api/layers/${layerId}/scale`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attribute, range, unit }),
        });
        if (response.ok) return (await response.json()) as SizeScale;
        setChannelError(await readApiError(response));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [layerId],
  );

  const dismissChannelError = useCallback(() => setChannelError(null), []);

  return { busy, channelError, dismissChannelError, classify, resolveScale };
}
