/*
 * The lens of a liquid panel: how far the edge of a rounded rectangle pulls
 * what lies behind it inward. The maths follows liquid-dom
 * (https://github.com/AndrewPrifer/liquid-dom, packages/core): the signed
 * distance field of a rounded rectangle, the normal of its edge, a convex
 * surface profile across a bezel and the refraction of a ray entering it
 * (index 1.5). liquid-dom refracts in WebGPU every frame; here the same lens
 * is baked once per size into a displacement map, which the browser's own
 * backdrop filter then applies.
 *
 * MIT License
 *
 * Copyright (c) 2026 Andras Prifer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** The width of the bezel the edge bends across, at most, in px. */
export const BEZEL = 14;
/** The glass's index of refraction. */
export const IOR = 1.5;
/** How soft the map is made, so the bend has no step (a gaussian, in px). */
export const MAP_BLUR = 1.5;
/** The deepest the surface profile is read, short of the vertical tangent. */
const PROFILE_LIMIT = 0.96;

/** How far a point lies inside a w × h rectangle with corners of radius r,
 * measured from its edge: positive inside, zero on the edge, negative
 * outside. */
export function edgeDistance(px: number, py: number, w: number, h: number, r: number): number {
  const hx = w / 2, hy = h / 2;
  const x = Math.abs(px - hx) - (hx - r), y = Math.abs(py - hy) - (hy - r);
  const outside = Math.hypot(Math.max(x, 0), Math.max(y, 0));
  const inside = Math.min(Math.max(x, y), 0);
  return -(outside + inside - r);
}

/** The edge's outward normal at a point, from the distance field's slope. */
export function edgeNormal(px: number, py: number, w: number, h: number, r: number): [number, number] {
  const nx = edgeDistance(px - 0.5, py, w, h, r) - edgeDistance(px + 0.5, py, w, h, r);
  const ny = edgeDistance(px, py - 0.5, w, h, r) - edgeDistance(px, py + 0.5, w, h, r);
  const length = Math.hypot(nx, ny) || 1;
  return [nx / length, ny / length];
}

/** How far a ray entering the convex surface at depth t across the bezel
 * (1 at the edge, 0 where the surface flattens) is turned: the surface's
 * slope there, less the angle refraction leaves it. */
export function surfaceBend(t: number): number {
  const tt = Math.min(Math.max(t, 0), PROFILE_LIMIT);
  const theta = Math.asin(tt);
  const phi = Math.asin(Math.sin(theta) / IOR);
  return Math.tan(theta - phi);
}

/** The bezel for a surface of this size: a third of its shorter side, between 4 and 14 px. */
export function bezelFor(w: number, h: number): number {
  return Math.min(BEZEL, Math.max(4, Math.min(w, h) / 3));
}

/** How far the edge pulls the backdrop in, in px: the role's lens, held to
 * a quarter of the shorter side so a small button is not torn, never under 3. */
export function shiftFor(lens: number, w: number, h: number): number {
  return Math.min(lens, Math.max(3, Math.min(w, h) / 4));
}

/** The corner as the lens draws it: no more than half a side, to the half pixel. */
export function cornerFor(radius: number, w: number, h: number): number {
  return Math.round(Math.min(Math.max(radius, 0), w / 2, h / 2) * 2) / 2;
}

/**
 * The displacement map of a w × h surface with corners of radius r, as RGBA
 * bytes: red carries the horizontal pull and green the vertical, 128 for
 * none, blue 128 and alpha opaque throughout. Across the bezel the
 * backdrop is pulled inward, most at the edge and not at all past the
 * bezel; outside the shape nothing moves. The map is softened by a small
 * gaussian over a neutral surround, so the pull has no step.
 */
export function displacementField(w: number, h: number, r: number): Uint8ClampedArray {
  const bezel = bezelFor(w, h);
  const peak = surfaceBend(1);
  const sx = new Float32Array(w * h), sy = new Float32Array(w * h);
  // Only a band along the edge carries a pull, and only that band and the
  // blur's reach around it can differ from neutral.
  const reach = Math.ceil(MAP_BLUR * 3);
  const band = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5, py = y + 0.5;
      const distance = edgeDistance(px, py, w, h, r);
      const i = y * w + x;
      if (distance < bezel + reach + 1) band[i] = 1;
      if (distance < 0 || distance >= bezel) continue;
      const magnitude = surfaceBend(1 - distance / bezel) / peak;
      const [nx, ny] = edgeNormal(px, py, w, h, r);
      sx[i] = -nx * magnitude * 127;
      sy[i] = -ny * magnitude * 127;
    }
  }
  const kernel = gaussian(MAP_BLUR, reach);
  const soft = (source: Float32Array) => blurBand(blurBand(source, w, h, kernel, band, 1), w, h, kernel, band, w);
  const bx = soft(sx), by = soft(sy);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = Math.round(128 + bx[i]);
    out[i * 4 + 1] = Math.round(128 + by[i]);
    out[i * 4 + 2] = 128;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A normalised gaussian kernel of the given deviation, `reach` taps each side. */
function gaussian(deviation: number, reach: number): Float32Array {
  const kernel = new Float32Array(reach * 2 + 1);
  let sum = 0;
  for (let k = -reach; k <= reach; k += 1) {
    const weight = Math.exp(-(k * k) / (2 * deviation * deviation));
    kernel[k + reach] = weight;
    sum += weight;
  }
  return kernel.map(weight => weight / sum);
}

/** One pass of the blur along rows (step 1) or columns (step w), over the
 * band only: every value outside it is neutral, as is everything past the
 * map's own edge. */
function blurBand(source: Float32Array, w: number, h: number, kernel: Float32Array, band: Uint8Array, step: number): Float32Array {
  const out = new Float32Array(w * h);
  const reach = (kernel.length - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!band[i]) continue;
      const along = step === 1 ? x : y, length = step === 1 ? w : h;
      let sum = 0;
      for (let k = -reach; k <= reach; k += 1) {
        const at = along + k;
        if (at < 0 || at >= length) continue;
        sum += source[i + k * step] * kernel[k + reach];
      }
      out[i] = sum;
    }
  }
  return out;
}
