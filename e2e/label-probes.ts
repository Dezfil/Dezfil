// Probes for map labels as a surface really draws them, shared by the label
// specs: which face and weight each glyph was drawn in, whether that face had
// arrived when it was, and how much of a colour an image holds.
//
// deck.gl draws every glyph a text layer needs once into a font atlas, through
// a 2D canvas whose `font` names the face and weight, and draws the map's text
// from that atlas. A record of those draws therefore says what a page's labels
// asked for, glyph by glyph, and `document.fonts.check` at the moment of each
// draw says whether that face was there to draw with or the glyph fell back.
// The record is the page's own; nothing in the product is changed or read
// from inside.
//
// The paint of an automatic label is read the same way on every surface:
// one label drawn over a district of a middle tone, the text colour counted
// inside its strokes, the halo as the district's colour pulled toward the
// halo's around them. deck draws the halo as the text's outline, a share of
// the glyph's distance field: at the recipes' width it is a soft rim
// narrower than the smoothing of the glyph's own edge, never a solid band,
// and it widens with the text, so the labels read this way are drawn large.
import type { BrowserContext, Page } from "@playwright/test";

export interface DrawnGlyph {
  /** The family the glyph was asked in: the first name of the font list. */
  family: string;
  weight: number;
  /** The size it was drawn at, in pixels: a text atlas draws at 64. */
  size: number;
  text: string;
  /** Whether the face it was asked in had loaded when it was drawn. */
  loaded: boolean;
  /** Milliseconds since the document started. */
  at: number;
}

/** Record every glyph the context's pages draw into a 2D canvas. */
export async function recordGlyphs(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const drawn: string[] = [];
    (window as unknown as { __glyphsDrawn: string[] }).__glyphsDrawn = drawn;
    const kinds = [
      (globalThis as { CanvasRenderingContext2D?: { prototype: CanvasRenderingContext2D } }).CanvasRenderingContext2D,
      (globalThis as { OffscreenCanvasRenderingContext2D?: { prototype: CanvasRenderingContext2D } }).OffscreenCanvasRenderingContext2D,
    ];
    for (const kind of kinds) {
      if (!kind) continue;
      const proto = kind.prototype;
      const fill = proto.fillText;
      proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
        // The face asked for first, alone: a later name in the list is
        // a fallback, loaded or not, and says nothing about the face.
        let loaded = false;
        try {
          loaded = document.fonts.check(this.font.replace(/,.*$/, ""), text);
        } catch {
          loaded = false;
        }
        drawn.push(JSON.stringify([this.font, String(text), loaded, Math.round(performance.now())]));
        return maxWidth === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, maxWidth);
      };
    }
  });
}

/** The first family a CSS font list names, unquoted, lower-cased. */
export function firstFamily(list: string): string {
  const first = list.split(",")[0] ?? "";
  return first.trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
}

/** A canvas `font` value read back: its weight and its first family. */
export function parseFont(font: string): { weight: number; size: number; family: string } {
  const match = /^(.*?)(\d+(?:\.\d+)?)px(?:\s*\/\s*\S+)?\s+(.+)$/.exec(font.trim());
  if (!match) return { weight: 400, size: 0, family: "" };
  const words = match[1].trim().split(/\s+/).filter(Boolean);
  let weight = 400;
  for (const word of words) {
    if (word === "bold") weight = 700;
    else if (word === "bolder") weight = 700;
    else if (word === "lighter") weight = 300;
    else if (/^\d{3}$/.test(word)) weight = Number(word);
  }
  return { weight, size: Number(match[2]), family: firstFamily(match[3]) };
}

/** Every glyph the page has drawn into a text atlas so far, in order: a
 * map's text atlases draw at 64 pixels, the page's other canvases (charts,
 * the basemap's own lettering) far smaller. */
export async function drawnGlyphs(page: Page): Promise<DrawnGlyph[]> {
  const raw = await page.evaluate(() => (window as unknown as { __glyphsDrawn?: string[] }).__glyphsDrawn ?? []);
  return raw
    .map((entry) => {
      const [font, text, loaded, at] = JSON.parse(entry) as [string, string, boolean, number];
      return { ...parseFont(font), text, loaded, at };
    })
    .filter((glyph) => glyph.size >= 48);
}

/** Forget what was drawn so far, so the next record is one surface's own. */
export async function forgetGlyphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const drawn = (window as unknown as { __glyphsDrawn?: string[] }).__glyphsDrawn;
    if (drawn) drawn.length = 0;
  });
}

/** The families the page's root declares for Inter and Archivo, as the
 * labels ask for them: the first name of each list. */
export async function declaredFaces(page: Page): Promise<{ inter: string; archivo: string }> {
  const lists = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { inter: root.getPropertyValue("--font-inter"), archivo: root.getPropertyValue("--font-archivo") };
  });
  return { inter: firstFamily(lists.inter), archivo: firstFamily(lists.archivo) };
}

/** The weights each kind of character was drawn at, per family: letters
 * and digits apart, every glyph drawn with its face loaded or not. */
export function weightsBy(glyphs: DrawnGlyph[], family: string, kind: RegExp) {
  const weights = new Set<number>();
  let fallback = 0;
  for (const glyph of glyphs) {
    if (glyph.family !== family || !kind.test(glyph.text)) continue;
    weights.add(glyph.weight);
    if (!glyph.loaded) fallback += 1;
  }
  return { weights: [...weights].sort((a, b) => a - b), fallback };
}

export const LETTER = /^\p{L}$/u;
export const DIGIT = /^\d$/;

/** How much of one colour an image holds over a flat ground: every pixel
 * read as a mix of the two, its share of the colour summed (an area in
 * pixels, so a heavier face holds more of it), and the pixels drawn in the
 * colour itself. A pixel off the line between the two is something else
 * and counts for nothing. The ground is the image's most common colour
 * unless one is given; a region narrows the read. */
export interface Ink {
  coverage: number;
  solid: number;
  ground: [number, number, number];
}

export async function inkOf(
  page: Page,
  png: Buffer,
  colour: readonly [number, number, number],
  options: { ground?: readonly [number, number, number]; region?: { x0: number; y0: number; x1: number; y1: number } } = {},
): Promise<Ink> {
  return page.evaluate(
    async ({ b64, colour, ground, region }) => {
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
      let g = ground;
      if (!g) {
        const counts = new Map<number, number>();
        for (let i = 0; i < data.length; i += 4) {
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let best = 0;
        let most = -1;
        for (const [key, n] of counts) if (n > most) { most = n; best = key; }
        g = [(best >> 16) & 255, (best >> 8) & 255, best & 255];
      }
      const d = [colour[0] - g[0], colour[1] - g[1], colour[2] - g[2]];
      const span = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const share = (i: number) => {
        const p = [data[i] - g![0], data[i + 1] - g![1], data[i + 2] - g![2]];
        const t = Math.max(0, Math.min(1, (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / span));
        const off = Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]);
        return { t, off };
      };
      // Without a region, the read is narrowed to where the colour itself is
      // drawn: the box of its strongest pixels, trimmed of strays and padded by
      // its edge, so nothing else on the page that leans its way counts.
      let r = region;
      if (!r) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let y = 0; y < c.height; y += 1) {
          for (let x = 0; x < c.width; x += 1) {
            const { t, off } = share((y * c.width + x) * 4);
            if (t > 0.6 && off <= 16) { xs.push(x); ys.push(y); }
          }
        }
        if (xs.length === 0) return { coverage: 0, solid: 0, ground: g as [number, number, number] };
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const at = (v: number[], q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
        const pad = 8;
        r = { x0: at(xs, 0.01) - pad, y0: at(ys, 0.01) - pad, x1: at(xs, 0.99) + pad + 1, y1: at(ys, 0.99) + pad + 1 };
      }
      let coverage = 0;
      let solid = 0;
      for (let y = Math.max(0, r.y0); y < Math.min(c.height, r.y1); y += 1) {
        for (let x = Math.max(0, r.x0); x < Math.min(c.width, r.x1); x += 1) {
          const { t, off } = share((y * c.width + x) * 4);
          if (off > 24) continue;
          coverage += t;
          if (t > 0.9) solid += 1;
        }
      }
      return { coverage, solid, ground: g as [number, number, number] };
    },
    { b64: png.toString("base64"), colour: [...colour], ground: options.ground ? [...options.ground] : null, region: options.region ?? null },
  );
}

/** How many pixels of an image sit within a tolerance of a colour. */
export async function pixelsNear(
  page: Page,
  png: Buffer,
  colour: readonly [number, number, number],
  tolerance = 10,
): Promise<number> {
  return page.evaluate(
    async ({ b64, colour, tolerance }) => {
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
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - colour[0]) <= tolerance &&
          Math.abs(data[i + 1] - colour[1]) <= tolerance &&
          Math.abs(data[i + 2] - colour[2]) <= tolerance
        ) n += 1;
      }
      return n;
    },
    { b64: png.toString("base64"), colour: [...colour], tolerance },
  );
}

/** A server image as the browser fetches it: POST a JSON body, answer the
 * PNG's bytes (or the error's text). */
export async function postForPng(
  page: Page,
  url: string,
  body: unknown,
): Promise<{ status: number; text: string; png: Buffer | null }> {
  const result = await page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) return { status: response.status, text: new TextDecoder().decode(bytes), b64: null };
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { status: response.status, text: "", b64: btoa(binary) };
    },
    { url, body },
  );
  return { status: result.status, text: result.text, png: result.b64 ? Buffer.from(result.b64, "base64") : null };
}

export type RGB = readonly [number, number, number];

/** The two recipes, as the label draws them. */
export const RECIPES = {
  light: { text: [36, 50, 48] as RGB, halo: [255, 255, 255] as RGB },
  dark: { text: [233, 236, 243] as RGB, halo: [11, 14, 20] as RGB },
};
/** The district under the label: a middle tone, so a white halo and a
 * near-black one each show against it. */
export const DISTRICT: RGB = [150, 110, 80];

const near = (a: readonly number[], b: RGB, tolerance: number) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

/** What the pixels around the label hold: each recipe's text and halo,
 * and the ground the map drew away from it. */
export interface Paint { light: { text: number; halo: number }; dark: { text: number; halo: number }; ground: [number, number, number]; district: number }

export async function paintOf(page: Page, png: Buffer): Promise<Paint> {
  return page.evaluate(
    async ({ b64, recipes, district }) => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const close = (i: number, t: number[], tol: number) =>
        Math.abs(data[i] - t[0]) <= tol && Math.abs(data[i + 1] - t[1]) <= tol && Math.abs(data[i + 2] - t[2]) <= tol;
      const found = { light: { text: 0, halo: 0 }, dark: { text: 0, halo: 0 }, district: 0 };
      // The label stands at the middle of its district, the one fill drawn:
      // wherever the camera puts it, the district's box finds it.
      const xs: number[] = [];
      const ys: number[] = [];
      for (let y = 0; y < c.height; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          if (close((y * c.width + x) * 4, district, 2)) { xs.push(x); ys.push(y); }
        }
      }
      if (xs.length === 0) return { ...found, ground: [0, 0, 0] as [number, number, number] };
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
      const box = { x0: q(xs, 0.01), x1: q(xs, 0.99), y0: q(ys, 0.01), y1: q(ys, 0.99) };
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      for (let y = Math.max(1, Math.floor(cy - 60)); y < Math.min(c.height - 1, cy + 60); y += 1) {
        for (let x = Math.max(1, Math.floor(cx - 170)); x < Math.min(c.width - 1, cx + 170); x += 1) {
          const i = (y * c.width + x) * 4;
          for (const tone of ["light", "dark"] as const) {
            // Text counts only inside a stroke: the pixel and its four
            // neighbours all in the colour. An edge blending a halo into
            // the ground can pass through either text colour, a pixel wide.
            const t = recipes[tone].text;
            if (close(i, t, 8) && close(i - 4, t, 8) && close(i + 4, t, 8) && close(i - c.width * 4, t, 8) && close(i + c.width * 4, t, 8)) found[tone].text += 1;
            // The halo: a pixel on the line from the district to the halo's
            // colour, at least a fifth of the way along.
            const h = recipes[tone].halo;
            const d = [h[0] - district[0], h[1] - district[1], h[2] - district[2]];
            const p = [data[i] - district[0], data[i + 1] - district[1], data[i + 2] - district[2]];
            const along = (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
            const off = Math.hypot(p[0] - along * d[0], p[1] - along * d[1], p[2] - along * d[2]);
            if (along >= 0.2 && along <= 1.05 && off <= 10) found[tone].halo += 1;
          }
          if (close(i, district, 6)) found.district += 1;
        }
      }
      // The ground: the most common colour of a band just outside the
      // district, which is the basemap and nothing else.
      const counts = new Map<number, number>();
      for (let y = Math.max(0, box.y0 - 50); y < Math.min(c.height, box.y1 + 50); y += 2) {
        for (let x = Math.max(0, box.x0 - 50); x < Math.min(c.width, box.x1 + 50); x += 2) {
          if (x >= box.x0 - 6 && x <= box.x1 + 6 && y >= box.y0 - 6 && y <= box.y1 + 6) continue;
          const i = (y * c.width + x) * 4;
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      let best = 0;
      let most = -1;
      for (const [key, n] of counts) if (n > most) { most = n; best = key; }
      return { ...found, ground: [(best >> 16) & 255, (best >> 8) & 255, best & 255] as [number, number, number] };
    },
    {
      b64: png.toString("base64"),
      recipes: {
        light: { text: [...RECIPES.light.text], halo: [...RECIPES.light.halo] },
        dark: { text: [...RECIPES.dark.text], halo: [...RECIPES.dark.halo] },
      },
      district: [...DISTRICT],
    },
  );
}

export const describePaint = (p: Paint) =>
  `light text ${p.light.text}, light halo ${p.light.halo}, dark text ${p.dark.text}, dark halo ${p.dark.halo}, ground ${p.ground.join(",")}, district ${p.district}`;

/** The label drawn in a tone's recipe and not the other's, over the
 * district, on the ground expected. */
export function holds(p: Paint, tone: "light" | "dark", ground?: RGB): boolean {
  const other = tone === "light" ? "dark" : "light";
  return p[tone].text > 60 && p[tone].halo > 200 && p[other].text === 0 && p[other].halo < 20 && p.district > 500
    && (ground === undefined || near(p.ground, ground, 6));
}
