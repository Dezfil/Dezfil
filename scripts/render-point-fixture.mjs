// Own the mark's size and opacity so the presence probe is independent of
// instance defaults. At the smallest probe width (480), radius 12 becomes
// 8 output pixels under the export's 720-wide reference: about 200 pixels.
// Requiring 100 leaves edge-sampling room while rejecting an empty image.
export const RENDER_POINT_STYLE = {
  fill: { type: 'constant', color: { r: 26, g: 93, b: 74, a: 1 } },
  fillOpacity: 1,
  stroke: { r: 0, g: 0, b: 0, a: 1 },
  strokeOpacity: 0,
  strokeWidth: 0,
  pointRadius: 12,
  opacity: 1,
};
export const MIN_POINT_PIXELS = 100;
