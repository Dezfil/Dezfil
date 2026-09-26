"use client";

import { useCallback, useRef, useState } from "react";
import type { LabelCount } from "./style-panel/LabelSection";

/**
 * The builder's label-count state — MapBuilder's at-touch slice: holds
 * the canvas's per-layer counts and deduplicates by value, so
 * camera-driven rebuilds whose counts did not change never re-render
 * the builder tree.
 */
export function useLabelCounts(): {
  labelCounts: Record<string, LabelCount | null>;
  onLabelCounts: (counts: Record<string, LabelCount | null>) => void;
} {
  const [labelCounts, setLabelCounts] = useState<
    Record<string, LabelCount | null>
  >({});
  const lastKey = useRef("");
  const onLabelCounts = useCallback(
    (counts: Record<string, LabelCount | null>) => {
      const key = JSON.stringify(counts);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setLabelCounts(counts);
    },
    [],
  );
  return { labelCounts, onLabelCounts };
}
