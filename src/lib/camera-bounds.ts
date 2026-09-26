import { CAMERA_BOUNDS } from "./map-runtime-limits";

/** Strict submitted-camera checks. Read recovery is a separate operation. */
export function cameraBoundsProblem(camera: Record<string, unknown>): string | null {
  for (const field of ["lat", "zoom", "pitch"] as const) {
    const value = field === "pitch" && camera.pitch === undefined ? 0 : camera[field];
    const { minimum, maximum } = CAMERA_BOUNDS[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `viewport.${field}: ${String(value)} must be a finite number (minimum ${minimum}, maximum ${maximum}).`;
    }
    if (value < minimum) return `viewport.${field}: ${value} is below the minimum ${minimum}.`;
    if (value > maximum) return `viewport.${field}: ${value} is above the maximum ${maximum}.`;
  }
  return null;
}

/** Compatibility only: expose finite legacy values inside the runtime
 * envelope, without rewriting the stored map or relaxing new submissions. */
export function recoverCamera<T extends { lat: number; zoom: number; pitch?: number }>(camera: T): T {
  const effective = { ...camera };
  for (const field of ["lat", "zoom", "pitch"] as const) {
    const value = camera[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      const { minimum, maximum } = CAMERA_BOUNDS[field];
      effective[field] = Math.min(maximum, Math.max(minimum, value));
    }
  }
  return effective;
}
