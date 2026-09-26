// Shared PNG region probes: decoded in-browser — the pixel suite's
// decode pattern — and reused by both export specs so the measurement
// itself cannot fork (the plan's measurement-validity rule).
import type { Page } from "@playwright/test";

export interface RegionStats {
  width: number;
  height: number;
  kelpLeft: number;
  kelpCenter: number;
  kelpRight: number;
  kelpBottomLeft: number;
  amberBottomLeft: number;
  inkTopLeft: number;
  inkBottomRight: number;
  accentTopRight: number;
}


export async function pngStats(page: Page, png: Buffer): Promise<RegionStats> {
  return page.evaluate(async (b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const near = (v: number, t: number) => Math.abs(v - t) <= 14;
    const stats = {
      width: bmp.width,
      height: bmp.height,
      kelpLeft: 0,
      kelpCenter: 0,
      kelpRight: 0,
      kelpBottomLeft: 0,
      amberBottomLeft: 0,
      inkTopLeft: 0,
      inkBottomRight: 0,
      accentTopRight: 0,
    };
    const W = bmp.width;
    const H = bmp.height;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const kelp = near(r, 26) && near(g, 93) && near(b, 74);
        const amber = near(r, 233) && near(g, 179) && near(b, 91);
        const ink = r < 80 && g < 80 && b < 80;
        // The attribution renders in muted gray, not near-black: any
        // clearly-darker-than-background pixel that is not map data.
        const mutedInk =
          r < 150 && g < 150 && b < 150 && !kelp && !amber;
        if (kelp) {
          if (x < W / 3) stats.kelpLeft += 1;
          else if (x < (2 * W) / 3) stats.kelpCenter += 1;
          else stats.kelpRight += 1;
        }
        // Corner regions: 30% x 40% boxes.
        const inBottomLeft = x < W * 0.3 && y > H * 0.6;
        const inTopLeft = x < W * 0.4 && y < H * 0.2;
        const inBottomRight = x > W * 0.65 && y > H * 0.9;
        const inTopRight = x > W * 0.72 && y < H * 0.55;
        if (kelp && inBottomLeft) stats.kelpBottomLeft += 1;
        if (amber && inBottomLeft) stats.amberBottomLeft += 1;
        if (ink && inTopLeft) stats.inkTopLeft += 1;
        if (mutedInk && inBottomRight) stats.inkBottomRight += 1;
        // The widget card's bars use the accent family — green-dominant
        // saturated pixels distinct from kelp fill dots are counted
        // loosely: any strongly green pixel in the rail region.
        if (inTopRight && g > 100 && g > r + 25 && g > b + 25)
          stats.accentTopRight += 1;
      }
    }
    return stats;
  }, png.toString("base64"));
}

/**
 * Where the data sits in the image, and how much of the image it takes.
 * Both are needed: the centroid says whether the same ground
 * is in frame, and the covered share says whether the map is drawn
 * finer. Marks are found by their distance from the basemap's greys
 * rather than by an exact colour, so any styled fixture works.
 */
export async function markStats(
  page: Page,
  png: Buffer,
): Promise<{
  width: number;
  height: number;
  share: number;
  /** Basemap ink — roads and label glyphs — measured over the image's
   * middle only. The corners carry the legend, the title, the rail and
   * the credit, whose type would otherwise drown out the thing being
   * measured. */
  ink: number;
  cx: number;
  cy: number;
}> {
  return page.evaluate(async (b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    let ink = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Saturated enough to be a data mark rather than basemap paper.
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // The basemap's own ink: dark and near-neutral, which is what road
      // casing and label glyphs are on light paper.
      const px0 = (i / 4) % c.width;
      const py0 = Math.floor(i / 4 / c.width);
      if (max - min < 40) {
        const middle =
          px0 > c.width * 0.3 &&
          px0 < c.width * 0.7 &&
          py0 > c.height * 0.3 &&
          py0 < c.height * 0.7;
        if (middle && max < 140) ink += 1;
        continue;
      }
      n += 1;
      sx += px0;
      sy += py0;
    }
    return {
      width: c.width,
      height: c.height,
      share: n / (c.width * c.height),
      ink: ink / (c.width * 0.4 * (c.height * 0.4)),
      cx: n ? sx / n / c.width : 0,
      cy: n ? sy / n / c.height : 0,
    };
  }, png.toString("base64"));
}

/**
 * Count pixels that retain a fixture's authored colour in the central half of
 * an image. Unlike `markStats`, this is intentionally not a general data-mark
 * probe: it proves that one named layer/label painted, while excluding
 * saturated basemap and composition chrome elsewhere in the frame.
 */
export async function targetColorCount(
  page: Page,
  png: Buffer,
  target: readonly [number, number, number],
  tolerance = 24,
): Promise<number> {
  return page.evaluate(
    async ({ b64, target, tolerance }) => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let count = 0;
      for (let y = Math.floor(c.height * 0.25); y < c.height * 0.75; y += 1) {
        for (let x = Math.floor(c.width * 0.25); x < c.width * 0.75; x += 1) {
          const i = (y * c.width + x) * 4;
          if (
            Math.abs(data[i] - target[0]) <= tolerance &&
            Math.abs(data[i + 1] - target[1]) <= tolerance &&
            Math.abs(data[i + 2] - target[2]) <= tolerance
          ) {
            count += 1;
          }
        }
      }
      return count;
    },
    { b64: png.toString("base64"), target: [...target], tolerance },
  );
}
