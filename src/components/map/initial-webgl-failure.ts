import { GPUInitializationError } from "maplibre-gl";

/**
 * MapLibre's established initial-context failure. Keep this deliberately
 * narrower than a general renderer error: later context loss and deck's
 * separate renderer lifecycle are different failures with different recovery
 * semantics.
 */
export const INITIAL_WEBGL_FAILURE_MESSAGE =
  "This browser could not start WebGL, so the map cannot be displayed. " +
  "Reload the page; if it still fails, update your browser or enable hardware acceleration.";

/** Use MapLibre's public error type; its human-readable wording may change. */
export function isInitialWebGLContextFailure(error: unknown): boolean {
  return error instanceof GPUInitializationError;
}

export type InitialWebGLAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Run only the initial MapLibre constructor through the narrow classifier.
 * Anything else is rethrown for the host's normal error path.
 */
export function attemptInitialWebGLMap<T>(start: () => T): InitialWebGLAttempt<T> {
  try {
    return { ok: true, value: start() };
  } catch (error) {
    if (!isInitialWebGLContextFailure(error)) throw error;
    return { ok: false, message: INITIAL_WEBGL_FAILURE_MESSAGE };
  }
}
