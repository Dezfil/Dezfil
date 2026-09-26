/**
 * MapLibre's established initial-context failure. Keep this deliberately
 * narrower than a general renderer error: later context loss and deck's
 * separate renderer lifecycle are different failures with different recovery
 * semantics.
 */
const MAPLIBRE_INITIAL_WEBGL_FAILURE = "Failed to initialize WebGL";

export const INITIAL_WEBGL_FAILURE_MESSAGE =
  "This browser could not start WebGL, so the map cannot be displayed. " +
  "Reload the page; if it still fails, update your browser or enable hardware acceleration.";

/** MapLibre throws either the plain message or JSON carrying that message. */
export function isInitialWebGLContextFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === MAPLIBRE_INITIAL_WEBGL_FAILURE) return true;

  try {
    const detail = JSON.parse(error.message) as unknown;
    return (
      typeof detail === "object" &&
      detail !== null &&
      "message" in detail &&
      detail.message === MAPLIBRE_INITIAL_WEBGL_FAILURE
    );
  } catch {
    return false;
  }
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
