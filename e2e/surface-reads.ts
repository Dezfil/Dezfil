// Reading a surface off the running page, shared by the journeys that hold
// the surface roles and the Panels looks: a computed colour or shadow as
// numbers, a row of the page as luminance, and the striped map whose hard
// edges show whether a surface blurs, or bends, what lies under it.
import type { Page } from "@playwright/test";

export type RGBA = [number, number, number, number];
export interface Layer { x: number; y: number; blur: number; spread: number; inset: boolean; colour: RGBA | null }

/** An OKLab colour as sRGB numbers, 0 to 255. */
function oklabToRgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return linear.map((c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) as [number, number, number];
}

/** An sRGB colour, 0 to 255, in OKLab. */
export function rgbToOklab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export { oklabToRgb };

/** A computed colour as numbers: `rgb()`, `rgba()`, and the `color(srgb …)`
 * and `oklab(…)` forms the browser gives a mix. */
export function colour(text: string): RGBA | null {
  const t = text.trim();
  if (t === "transparent") return [0, 0, 0, 0];
  const rgb = /^rgba?\(([^)]*)\)$/.exec(t);
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  const srgb = /^color\(srgb\s+([^)/]*)(?:\/\s*([^)]*))?\)$/.exec(t);
  if (srgb) {
    const p = srgb[1].trim().split(/\s+/).map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255, srgb[2] === undefined ? 1 : Number(srgb[2])];
  }
  const lab = /^oklab\(([^)/]*)(?:\/\s*([^)]*))?\)$/.exec(t);
  if (lab) {
    const p = lab[1].trim().split(/\s+/).map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : Number(v)));
    return [...oklabToRgb(p[0], p[1], p[2]), lab[2] === undefined ? 1 : Number(lab[2])];
  }
  return null;
}
export const sameColour = (a: RGBA | null, b: RGBA) =>
  a !== null && Math.abs(a[0] - b[0]) <= 1.5 && Math.abs(a[1] - b[1]) <= 1.5 && Math.abs(a[2] - b[2]) <= 1.5 && Math.abs(a[3] - b[3]) <= 0.006;
export const fmt = (c: RGBA | null) => (c ? `rgba(${c.slice(0, 3).map((v) => Math.round(v)).join(", ")}, ${Number(c[3].toFixed(3))})` : "no colour");

/** A computed box-shadow's layers, split at the commas between layers. */
export function layers(text: string): Layer[] {
  if (text.trim() === "none") return [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => {
    const c = /(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|transparent)/.exec(part);
    const rest = (c ? part.replace(c[0], " ") : part).trim();
    const inset = /\binset\b/.test(rest);
    const n = rest.replace(/\binset\b/, " ").trim().split(/\s+/).filter(Boolean).map((v) => parseFloat(v));
    return { x: n[0] ?? 0, y: n[1] ?? 0, blur: n[2] ?? 0, spread: n[3] ?? 0, inset, colour: c ? colour(c[0]) : null };
  });
}

/** A row of the page as luminance, one value per pixel. */
export async function rowLuma(page: Page, x: number, y: number, width: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width, height: 1 } });
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
    const { data } = ctx.getImageData(0, 0, c.width, 1);
    const out: number[] = [];
    for (let i = 0; i < data.length; i += 4) out.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    return out;
  }, png.toString("base64"));
}
export const range = (v: number[]) => Math.max(...v) - Math.min(...v);
export const maxStep = (v: number[]) => v.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(x - v[i])), 0);

/** What paints inside the map card across a row: a window "beside" the
 * glass must cross nothing but the drawn map. */
export async function paintersAcross(page: Page, x: number, y: number, width: number): Promise<string[]> {
  return page.evaluate(({ x, y, width }) => {
    const card = document.querySelector("[data-drag-canvas]")?.parentElement;
    if (!card) return ["no map card"];
    const found: string[] = [];
    for (const el of Array.from(card.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= x || r.left >= x + width || r.bottom <= y || r.top > y) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const cs = getComputedStyle(el);
      const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      const paints = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.getPropertyValue("backdrop-filter") !== "none" || cs.boxShadow !== "none"
        || cs.borderTopStyle !== "none" || ["svg", "img", "canvas"].includes(el.tagName.toLowerCase()) || text;
      if (paints) found.push(`${el.tagName.toLowerCase()}.${el.className}`);
    }
    return found;
  }, { x, y, width });
}

/** Vertical stripes in black and white, alternating, one polygon each: a
 * hard edge every stripe, wherever the map is looked at. */
const STRIPES = 140;
export function stripesGeoJson(): string {
  const west = 13.0;
  const east = 13.8;
  const step = (east - west) / STRIPES;
  const features = Array.from({ length: STRIPES }, (_, i) => {
    const a = west + i * step;
    const b = a + step;
    return {
      type: "Feature",
      properties: { band: i % 2 === 0 ? "ink" : "paper" },
      geometry: { type: "Polygon", coordinates: [[[a, 52.3], [b, 52.3], [b, 52.7], [a, 52.7], [a, 52.3]]] },
    };
  });
  return JSON.stringify({ type: "FeatureCollection", features });
}
export const STRIPES_STYLE = {
  fill: {
    type: "categorical",
    attribute: "band",
    palette: "vivid",
    map: [
      { value: "ink", color: { r: 0, g: 0, b: 0, a: 1 } },
      { value: "paper", color: { r: 255, g: 255, b: 255, a: 1 } },
    ],
    other: { r: 128, g: 128, b: 128, a: 1 },
  },
  fillOpacity: 1,
  stroke: { r: 0, g: 0, b: 0, a: 1 },
  strokeOpacity: 0,
  strokeWidth: 0,
  pointRadius: 4,
  opacity: 1,
};
