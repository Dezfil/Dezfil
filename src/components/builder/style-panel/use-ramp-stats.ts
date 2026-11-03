"use client";

import { useEffect, useState } from "react";
import type { FieldStats } from "@/lib/layer-service";

/** The statistics read behind a ramp: the attribute's stats, or with
 * "classification" the distribution its classification sees. The panel
 * makes a new function whenever the values' source changes. */
export type FetchStats = (
  attribute: string,
  distribution?: "classification",
) => Promise<FieldStats | null>;

/**
 * A ramp's distribution, refetched when the attribute, the request or the
 * source moves. An answer is kept with the fetcher, attribute and request
 * it answered, and shown only while all three are current, so a
 * distribution never renders for another column, scale or source while
 * the fresh one is in flight, nor after that one failed.
 */
export function useRampStats(
  fetchStats: FetchStats,
  attribute: string | null,
  distribution: "classification" | undefined,
): FieldStats | null {
  const [answered, setAnswered] = useState<{
    fetcher: FetchStats;
    attribute: string;
    distribution: "classification" | undefined;
    stats: FieldStats;
  } | null>(null);
  useEffect(() => {
    if (!attribute) return;
    let cancelled = false;
    void fetchStats(attribute, distribution).then((stats) => {
      if (!cancelled && stats) setAnswered({ fetcher: fetchStats, attribute, distribution, stats });
    });
    return () => {
      cancelled = true;
    };
  }, [attribute, distribution, fetchStats]);
  return answered &&
    answered.fetcher === fetchStats &&
    answered.attribute === attribute &&
    answered.distribution === distribution
    ? answered.stats
    : null;
}
