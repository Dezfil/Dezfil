/**
 * Map overlay corners (note, legend): the only positions an overlay can
 * occupy — placement is always one of these four, never free-form.
 * Dependency-free; reaches the client bundle.
 */

export const CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export type Corner = (typeof CORNERS)[number];

export function isCorner(value: unknown): value is Corner {
  return CORNERS.includes(value as Corner);
}
