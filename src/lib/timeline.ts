/**
 * The map's docked timeline. At most one per map: it names the layer whose
 * time filter is expanded into the map-docked playback widget, plus the
 * sweep speed. The window itself is NOT here — it stays the layer's
 * timerange filter, so undo, publish, and the API see one source of truth.
 */
export interface MapTimeline {
  layerId: string;
  /** The temporal field — must match a timerange filter on the layer. */
  field: string;
  /** Sweep-speed multiplier; 1 crosses the extent at the base rate. */
  speed: number;
}

export const TIMELINE_SPEED = { min: 0.25, max: 32, default: 1 } as const;

/** Shape check only — whether the dock target exists on the map is the
 * service's job, where the map is at hand. */
export function isValidTimeline(
  value: unknown,
): value is { layerId: string; field: string; speed?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.layerId !== "string" || t.layerId.length === 0) return false;
  if (typeof t.field !== "string" || t.field.length === 0) return false;
  if (t.speed === undefined) return true;
  return (
    typeof t.speed === "number" &&
    Number.isFinite(t.speed) &&
    t.speed >= TIMELINE_SPEED.min &&
    t.speed <= TIMELINE_SPEED.max
  );
}
