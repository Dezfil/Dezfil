import { limits } from "@/lib/limits";

export const ATTEMPTS_PER_ROW = 2;
export const ATTEMPTS_PER_ORIGIN = 2;
type Budget = Pick<typeof limits, "operationTimeoutMs" | "queryTimeoutMs" | "geocodePaceMs" | "geocodeRequestTimeoutMs" | "isochronePaceMs" | "isochroneRequestTimeoutMs">;

/** Admission and configuration report the same budget, without loading an engine.
 * Each exchange may consume its deadline or pace twice, with one query reserved
 * for publication. Geocoding retains its one-row floor; routing can admit none. */
export function maxBatchRows(budget: Budget = limits): number {
  const perRow = Math.max(budget.geocodePaceMs, budget.geocodeRequestTimeoutMs) * ATTEMPTS_PER_ROW;
  return Math.max(1, Math.floor((budget.operationTimeoutMs - budget.queryTimeoutMs) / Math.max(1, perRow)));
}

export function maxIsochroneOrigins(budget: Budget = limits): number {
  const perOrigin = Math.max(budget.isochronePaceMs, budget.isochroneRequestTimeoutMs) * ATTEMPTS_PER_ORIGIN;
  return Math.max(0, Math.floor((budget.operationTimeoutMs - budget.queryTimeoutMs) / Math.max(1, perOrigin)));
}
