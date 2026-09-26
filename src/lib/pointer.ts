/**
 * Pointer capability for the published cursor readout. A coarse-pointer
 * device has no cursor, so the readout is omitted entirely — no
 * tap-to-read, no crosshair. Dependency-free; reaches the client bundle.
 */

/** A device qualifies when any of its pointers is fine (mouse, trackpad,
 * stylus) — a hybrid laptop with a touchscreen still has a cursor. */
export const FINE_POINTER_QUERY = "(any-pointer: fine)";

/** True when a cursor exists to read. The media source is injectable so
 * the guard is testable off-browser; the default reads the window. */
export function hasFinePointer(
  media: (query: string) => { matches: boolean } = (query) =>
    window.matchMedia(query),
): boolean {
  return media(FINE_POINTER_QUERY).matches;
}
