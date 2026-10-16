import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookChoices } from "@/lib/look";

/**
 * Readability under the Panels looks. Every surface that carries words
 * keeps a fill strong enough that its quiet ink reads at 4.5:1 or better
 * over the strictest place it can sit, in each of the four Colors and both
 * themes, under Liquid and under Paper: computed here
 * from the fills the looks' stylesheets declare and the tones the page
 * declares, the backdrop unblurred, as a person's eye would meet it at the
 * worst spot. The numbers are printed for the record.
 */

type RGBA = [number, number, number, number];
type Theme = "light" | "dark";
type Look = "liquid" | "paper";
type Rule = { selectors: string[]; within: string | null; tokens: Map<string, string> };

/** Every rule of a stylesheet, comments removed, with the at-rule it sits in. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let within: string | null = null;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "}") { within = null; start = at + 1; continue; }
    if (text[at] !== "{") continue;
    const head = text.slice(start, at).trim().replace(/\s+/g, " ");
    if (head.startsWith("@")) { within = head; start = at + 1; continue; }
    const close = text.indexOf("}", at);
    out.push({
      selectors: head.split(",").map(selector => selector.trim()),
      within,
      tokens: new Map([...text.slice(at + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim().replace(/\s+/g, " ")])),
    });
    at = close;
    start = close + 1;
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const GLOBALS = rules(read("src/app/globals.css"));
const LOOK = rules(read("src/app/look.css"));
const LIQUID_CSS = read("src/app/look-liquid.css");
const PAPER_CSS = read("src/app/look-paper.css");

/** Tokens of the top-level rules carrying exactly this selector, in source order. */
const tokensOf = (sheet: Rule[], selector: string) =>
  new Map(sheet.filter(rule => rule.within === null && rule.selectors.includes(selector)).flatMap(rule => [...rule.tokens]));

/** A Color's tones in a theme, as the page declares them on the root. */
function tones(color: string, theme: Theme): Map<string, string> {
  const dark = theme === "dark";
  const layers = [tokensOf(GLOBALS, ":root"), dark ? tokensOf(GLOBALS, ':root[data-theme="dark"]') : new Map<string, string>()];
  if (color !== "kelp") {
    layers.push(tokensOf(LOOK, `:root[data-look-color="${color}"]`));
    if (dark) layers.push(tokensOf(LOOK, `:root[data-theme="dark"][data-look-color="${color}"]`));
  }
  return new Map(layers.flatMap(layer => [...layer]));
}

/** A look's restated roles on the root, over the shipped block. */
function restated(look: Look, theme: Theme, liquidCss: string, paperCss: string): Map<string, string> {
  const dark = theme === "dark" ? '[data-theme="dark"]' : "";
  const keys = [`[data-look-panels="${look}"]`];
  const sheet = rules(look === "liquid" ? liquidCss : paperCss);
  const light = keys.map(key => tokensOf(sheet, `:root${key}`));
  const night = theme === "dark" ? keys.map(key => tokensOf(sheet, `:root${dark}${key}`)) : [];
  return new Map([...light, ...night].flatMap(layer => [...layer]));
}

/* ---- colour arithmetic, as CSS Color 4 and 5 define it ---- */

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = ([r, g, b]: RGBA) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** One colour over another, source over. */
const over = (top: RGBA, under: RGBA): RGBA => {
  const alpha = top[3] + under[3] * (1 - top[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const c = [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / alpha);
  return [c[0], c[1], c[2], alpha];
};
const toOklab = ([r, g, b]: RGBA) => {
  const [lr, lg, lb] = [r, g, b].map(linear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromOklab = ([L, A, B]: number[]): [number, number, number] => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return rgb.map(c => Math.min(1, Math.max(0, gamma(c)))) as [number, number, number];
};

/** Split at the commas outside parentheses. */
function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { out.push(current.trim()); current = ""; } else current += char;
  }
  return [...out, current.trim()];
}

/** A colour value as the browser computes it on an element declaring these tokens. */
function colour(value: string, scope: Map<string, string>, depth = 0): RGBA {
  if (depth > 8) throw new Error(`${value} refers too deep`);
  const text = value.trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(text);
  if (reference) {
    const next = scope.get(reference[1]);
    if (next === undefined) throw new Error(`${reference[1]} is not declared`);
    return colour(next, scope, depth + 1);
  }
  if (text === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(d => d + d).join("") : hex[1];
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255).concat(1) as RGBA;
  }
  const rgba = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map(part => part.trim());
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
  }
  const mix = /^color-mix\(in (srgb|oklab), (.*)\)$/.exec(text);
  if (mix) {
    const [first, second] = args(mix[2]).map(part => {
      const share = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(part);
      return share ? { colour: colour(share[1], scope, depth + 1), share: Number(share[2]) } : { colour: colour(part, scope, depth + 1), share: null };
    });
    // The shares: one missing is the rest of 100; a sum under 100 thins the result.
    const p = first.share ?? (second.share === null ? 50 : 100 - second.share), q = second.share ?? 100 - p;
    const sum = p + q, wp = p / sum, wq = q / sum;
    const alpha = first.colour[3] * wp + second.colour[3] * wq;
    const thinned = alpha * Math.min(1, sum / 100);
    if (alpha === 0) return [0, 0, 0, 0];
    if (mix[1] === "srgb") {
      const c = [0, 1, 2].map(i => (first.colour[i] * first.colour[3] * wp + second.colour[i] * second.colour[3] * wq) / alpha);
      return [c[0], c[1], c[2], thinned];
    }
    const a = toOklab(first.colour), b = toOklab(second.colour);
    const lab = a.map((v, i) => (v * first.colour[3] * wp + b[i] * second.colour[3] * wq) / alpha);
    return [...fromOklab(lab), thinned];
  }
  throw new Error(`${text}: not a colour this reading knows`);
}

/* ---- where each surface is read, and with which ink ---- */

/** The strictest backdrops, unblurred: the darkest data class by day and
 * the brightest by night; a page's ground and a pattern line on it. */
const CELL: Record<Theme, string> = { light: "#7f3c8d", dark: "#f2b701" };
const LINE = "color-mix(in srgb, var(--fg) 22%, transparent)";
const VEIL = "color-mix(in srgb, var(--fg) 32%, transparent)";

type Backdrop = "cell" | "veil" | "ground" | "inspector";
/** Every surface a role draws that carries words and where it can sit;
 * each is read in the quiet ink, which no look steps up. */
const SURFACES: { role: string; part: string; over: Backdrop[] }[] = [
  { role: "glass-chrome", part: "fill", over: ["cell"] },
  { role: "glass-panel", part: "fill", over: ["cell"] },
  { role: "overlay-panel", part: "fill", over: ["cell"] },
  { role: "overlay-control", part: "fill", over: ["cell"] },
  { role: "map-card", part: "fill", over: ["cell"] },
  { role: "page-card", part: "fill", over: ["ground"] },
  { role: "inner-card", part: "fill", over: ["inspector"] },
  { role: "block", part: "fill", over: ["inspector"] },
  { role: "block", part: "fill-panel", over: ["inspector"] },
  { role: "menu", part: "fill", over: ["cell"] },
  { role: "menu", part: "fill-raised", over: ["cell"] },
  { role: "dialog", part: "fill", over: ["veil"] },
];
const FLOOR = 4.5;
const COLORS = lookChoices("color");

type Reading = { look: Look; color: string; theme: Theme; surface: string; ratio: number; alpha: number };

/** Every reading for both looks; the stylesheets' text can be seeded. */
function readings(liquidCss = LIQUID_CSS, paperCss = PAPER_CSS): Reading[] {
  const block = GLOBALS.find(rule => rule.tokens.has("--surface-menu-shadow"))!.tokens;
  const out: Reading[] = [];
  for (const look of ["liquid", "paper"] as Look[]) for (const color of COLORS) for (const theme of ["light", "dark"] as Theme[]) {
    const scope = new Map([...tones(color, theme), ...block, ...restated(look, theme, liquidCss, paperCss)]);
    const at = (value: string) => colour(value, scope);
    const cell = at(CELL[theme]);
    const fill = (role: string, part: string) => at(`var(--surface-${role}-${part})`);
    const backdrops: Record<Backdrop, RGBA[]> = {
      cell: [cell],
      veil: [over(at(VEIL), cell)],
      ground: [at("var(--bg)"), over(at(LINE), at("var(--bg)"))],
      inspector: [over(fill("glass-panel", "fill"), cell)],
    };
    for (const surface of SURFACES) {
      const ink = at("var(--fg-muted)");
      const ground = fill(surface.role, surface.part);
      const ratio = Math.min(...surface.over.flatMap(name => backdrops[name]).map(backdrop => contrast(ink, over(ground, backdrop))));
      out.push({ look, color, theme, surface: `${surface.role} ${surface.part}`, ratio, alpha: ground[3] });
    }
  }
  return out;
}

const below = (all: Reading[]) => all.filter(reading => reading.ratio < FLOOR)
  .map(reading => `${reading.look} ${reading.color} ${reading.theme} ${reading.surface}: ${reading.ratio.toFixed(2)}`);

describe("readability under the Panels looks", () => {
  it("reads the quiet ink at 4.5:1 or better over the strictest place, in every Color and theme, under Liquid and Paper", () => {
    const all = readings();
    expect(all).toHaveLength(2 * COLORS.length * 2 * SURFACES.length);
    // The record: one line per look, Color and theme, the surfaces' ratios in order.
    const lines = ["look    color    theme  " + SURFACES.map(surface => `${surface.role} ${surface.part}`).join(" | ")];
    for (const look of ["liquid", "paper"]) for (const color of COLORS) for (const theme of ["light", "dark"]) {
      const row = all.filter(reading => reading.look === look && reading.color === color && reading.theme === theme);
      lines.push(`${look.padEnd(7)} ${color.padEnd(8)} ${theme.padEnd(6)} ${row.map(reading => reading.ratio.toFixed(2)).join(" | ")}`);
    }
    console.log(lines.join("\n"));
    expect(below(all)).toEqual([]);
  });

  it("reads Kelp's numbers as the design measured them", () => {
    const kelp = (look: Look, theme: Theme, surface: string) =>
      Number(readings().find(reading => reading.look === look && reading.color === "kelp" && reading.theme === theme && reading.surface === surface)!.ratio.toFixed(2));
    // The one fill read in the quiet ink: on the chrome and the read panels over a cell, a page card over a line, an
    // inner card and a block over the inspector, a dialog over the veil.
    const surfaces = ["glass-chrome fill", "glass-panel fill", "page-card fill", "inner-card fill", "block fill", "dialog fill"];
    expect(surfaces.map(surface => kelp("liquid", "light", surface))).toEqual([4.59, 4.59, 5.05, 5.22, 5.22, 4.55]);
    expect(surfaces.map(surface => kelp("liquid", "dark", surface))).toEqual([4.9, 4.9, 6.78, 6.95, 6.95, 4.69]);
  });

  it("finds every fill Paper declares opaque, and every fill Liquid declares on request", () => {
    expect(readings().filter(reading => reading.look === "paper" && reading.alpha < 1).map(reading => reading.surface)).toEqual([]);
    const request = rules(LIQUID_CSS).filter(rule => rule.within !== null);
    expect(request.length).toBeGreaterThan(0);
    for (const color of COLORS) for (const theme of ["light", "dark"] as Theme[]) {
      const scope = tones(color, theme);
      for (const rule of request.filter(rule => rule.selectors.some(selector => selector.includes('[data-theme="dark"]') === (theme === "dark")))) {
        for (const [token, value] of rule.tokens) expect(colour(value, scope)[3], `${color} ${theme} ${token}`).toBeCloseTo(1, 9);
      }
    }
  });

  it("fails on a thinner fill", () => {
    const thinner = LIQUID_CSS.replaceAll("var(--bg-panel) 82.8%)", "var(--bg-panel) 60%)");
    expect(thinner).not.toBe(LIQUID_CSS);
    const failing = below(readings(thinner));
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some(line => line.startsWith("liquid kelp light glass-panel fill"))).toBe(true);
    const paperThin = PAPER_CSS.replace("--surface-page-card-fill: color-mix(in oklab, var(--bg-panel) 96%, var(--bg));",
      "--surface-page-card-fill: color-mix(in srgb, var(--bg-panel) 30%, transparent);");
    expect(paperThin).not.toBe(PAPER_CSS);
    expect(below(readings(LIQUID_CSS, paperThin)).some(line => line.startsWith("paper kelp light page-card fill"))).toBe(true);
  });
});
