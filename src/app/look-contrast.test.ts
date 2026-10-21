import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookChoices } from "@/lib/look";

/**
 * Readability under the Panels looks. Every surface that carries words
 * keeps a fill strong enough that its quiet ink reads at 4.5:1 or better
 * over the strictest data colour below, in each of the four Colors and both
 * themes, at both Contrasts, under Liquid at each of its transparency steps
 * and under Paper: computed here
 * from the fills the looks' stylesheets declare and the tones the page
 * declares, the backdrop unblurred, as a person's eye would meet it at the
 * worst spot, in the quiet ink the page's body takes under that look (Liquid
 * steps it toward the ink). The numbers are printed for the record.
 *
 * Liquid's fill is clear by choice, so it is not held over a map that runs
 * against the theme: a uniform black area by day (a dark basemap, satellite
 * imagery, the dark end of a grey ramp) or a white one by night. There its
 * text reads at about 3:1 at Clear, less badly at each firmer step, and
 * Glass and Paper keep their panels firm.
 */

type RGBA = [number, number, number, number];
type Theme = "light" | "dark";
type Look = "liquid" | "paper";
type Step = "clear" | "medium" | "firm";
const STEPS: Step[] = ["clear", "medium", "firm"];
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

/** A Color's tones in a theme and at a Contrast, as the page declares them on the root. */
function tones(color: string, theme: Theme, contrast = "standard"): Map<string, string> {
  const dark = theme === "dark";
  const layers = [tokensOf(GLOBALS, ":root"), dark ? tokensOf(GLOBALS, ':root[data-theme="dark"]') : new Map<string, string>()];
  const own = color === "kelp" ? "" : `[data-look-color="${color}"]`;
  if (own) {
    layers.push(tokensOf(LOOK, `:root${own}`));
    if (dark) layers.push(tokensOf(LOOK, `:root[data-theme="dark"]${own}`));
  }
  if (contrast !== "standard") {
    layers.push(tokensOf(LOOK, `:root${own}[data-look-contrast="${contrast}"]`));
    if (dark) layers.push(tokensOf(LOOK, `:root[data-theme="dark"]${own}[data-look-contrast="${contrast}"]`));
  }
  return new Map(layers.flatMap(layer => [...layer]));
}

/** A look's restated roles on the root at a step, over the shipped block,
 * as the cascade orders them: by day, by night, the step by day, the step by night. */
function restated(look: Look, theme: Theme, step: Step, liquidCss: string, paperCss: string): Map<string, string> {
  const night = theme === "dark" ? '[data-theme="dark"]' : "";
  const key = `[data-look-panels="${look}"]`, stepped = step === "clear" ? "" : `[data-look-transparency="${step}"]`;
  const sheet = rules(look === "liquid" ? liquidCss : paperCss);
  const chain = [`:root${key}`, ...(night ? [`:root${night}${key}`] : []),
    ...(stepped ? [`:root${key}${stepped}`, ...(night ? [`:root${night}${key}${stepped}`] : [])] : [])];
  return new Map(chain.flatMap(selector => [...tokensOf(sheet, selector)]));
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

/** The strictest backdrops held, unblurred: the darkest class of the vivid
 * palette by day and its brightest by night (not a black or white area, see
 * above); a page's ground and a pattern line on it. */
const CELL: Record<Theme, string> = { light: "#7f3c8d", dark: "#f2b701" };
const LINE = "color-mix(in srgb, var(--fg) 22%, transparent)";
const VEIL = "color-mix(in srgb, var(--fg) 32%, transparent)";

type Backdrop = "cell" | "veil" | "ground" | "inspector";
/** Every surface a role draws that carries words and where it can sit;
 * each is read in the quiet ink the body takes. */
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
const CONTRASTS = lookChoices("contrast");
/** The steps a look reads at: Liquid's three, Paper's one. */
const stepsOf = (look: Look): Step[] => (look === "liquid" ? STEPS : ["clear"]);

type Reading = { look: Look; color: string; theme: Theme; contrast: string; step: Step; surface: string; ratio: number; alpha: number };

/** Every reading for both looks; the stylesheets' text can be seeded. */
function readings(liquidCss = LIQUID_CSS, paperCss = PAPER_CSS): Reading[] {
  const block = GLOBALS.find(rule => rule.tokens.has("--surface-menu-shadow"))!.tokens;
  const out: Reading[] = [];
  for (const look of ["liquid", "paper"] as Look[]) for (const color of COLORS) for (const theme of ["light", "dark"] as Theme[])
  for (const level of CONTRASTS) for (const step of stepsOf(look)) {
    const scope = new Map([...tones(color, theme, level), ...block, ...restated(look, theme, step, liquidCss, paperCss)]);
    const at = (value: string) => colour(value, scope);
    const cell = at(CELL[theme]);
    const fill = (role: string, part: string) => at(`var(--surface-${role}-${part})`);
    const backdrops: Record<Backdrop, RGBA[]> = {
      cell: [cell],
      veil: [over(at(VEIL), cell)],
      ground: [at("var(--bg)"), over(at(LINE), at("var(--bg)"))],
      inspector: [over(fill("glass-panel", "fill"), cell)],
    };
    // The body's quiet ink: as the look's sheet restates it on the body, else the root's.
    const body = tokensOf(rules(look === "liquid" ? liquidCss : paperCss), `:root[data-look-panels="${look}"] body`);
    const ink = at(body.get("--fg-muted") ?? "var(--fg-muted)");
    for (const surface of SURFACES) {
      const ground = fill(surface.role, surface.part);
      const ratio = Math.min(...surface.over.flatMap(name => backdrops[name]).map(backdrop => contrast(ink, over(ground, backdrop))));
      out.push({ look, color, theme, contrast: level, step, surface: `${surface.role} ${surface.part}`, ratio, alpha: ground[3] });
    }
  }
  return out;
}

const below = (all: Reading[]) => all.filter(reading => reading.ratio < FLOOR)
  .map(reading => `${reading.look} ${reading.color} ${reading.theme} ${reading.contrast} ${reading.step} ${reading.surface}: ${reading.ratio.toFixed(2)}`);

/** Each step's fills as Liquid's design names them: the tint, then the
 * panel share of the roles and of a dialog. */
const SHARES: Record<Theme, Record<Step, [string, number, number]>> = {
  light: { clear: ["#fff 10%", 36, 40], medium: ["#fff 10%", 52, 54], firm: ["#fff 10%", 68, 70] },
  dark: { clear: ["#000 8%", 54, 54], medium: ["#000 10%", 62, 64], firm: ["#000 10%", 74, 76] },
};
/** The sheet with one step's fills some points thinner. */
const thinner = (theme: Theme, step: Step, points: number) => {
  const [tint, body, dialog] = SHARES[theme][step];
  return [...new Set([body, dialog])].reduce((css, share) =>
    css.replaceAll(`${tint}, var(--bg-panel) ${share}%)`, `${tint}, var(--bg-panel) ${share - points}%)`), LIQUID_CSS);
};
/** The sheet with one step's quiet inks left at the Color's own grey. */
const unstepped = (theme: Theme, step: Step) => {
  const root = `:root${theme === "dark" ? '[data-theme="dark"]' : ""}[data-look-panels="liquid"]${step === "clear" ? "" : `[data-look-transparency="${step}"]`} {`;
  const at = LIQUID_CSS.indexOf(`\n${root}\n  --liquid-fg-muted: `);
  const end = LIQUID_CSS.indexOf("}", at);
  return `${LIQUID_CSS.slice(0, at)}\n${root}\n  --liquid-fg-muted: var(--fg-muted);\n  --liquid-fg-faint: var(--fg-faint);\n${LIQUID_CSS.slice(end)}`;
};

describe("readability under the Panels looks", () => {
  it("reads the quiet ink at 4.5:1 or better over the strictest place, in every Color, theme and Contrast, under Liquid at each step and under Paper", () => {
    const all = readings();
    expect(all).toHaveLength(COLORS.length * 2 * CONTRASTS.length * (STEPS.length + 1) * SURFACES.length);
    // The record: one line per look, Color, theme, Contrast and step, the surfaces' ratios in order.
    const lines = ["look    color    theme  contrast step   " + SURFACES.map(surface => `${surface.role} ${surface.part}`).join(" | ")];
    for (const look of ["liquid", "paper"] as Look[]) for (const color of COLORS) for (const theme of ["light", "dark"])
    for (const contrast of CONTRASTS) for (const step of stepsOf(look)) {
      const row = all.filter(reading => reading.look === look && reading.color === color && reading.theme === theme
        && reading.contrast === contrast && reading.step === step);
      lines.push(`${look.padEnd(7)} ${color.padEnd(8)} ${theme.padEnd(6)} ${contrast.padEnd(8)} ${step.padEnd(6)} ${row.map(reading => reading.ratio.toFixed(2)).join(" | ")}`);
    }
    console.log(lines.join("\n"));
    expect(below(all)).toEqual([]);
  });

  it("reads Kelp's numbers as the design measured them, at each step", () => {
    const kelp = (theme: Theme, step: Step, surface: string) =>
      Number(readings().find(reading => reading.look === "liquid" && reading.color === "kelp" && reading.theme === theme
        && reading.contrast === "standard" && reading.step === step && reading.surface === surface)!.ratio.toFixed(2));
    // The one clear fill read in the stepped quiet ink: on the chrome and the read panels over a cell, a page card over
    // a line, an inner card and a block over the inspector, a dialog (a touch firmer) over the veil.
    const surfaces = ["glass-chrome fill", "glass-panel fill", "page-card fill", "inner-card fill", "block fill", "dialog fill"];
    const measured: Record<Theme, Record<Step, number[]>> = {
      light: { clear: [4.56, 4.56, 8.84, 7.29, 7.29, 4.61], medium: [4.69, 4.69, 7.26, 7.05, 7.05, 4.66], firm: [4.69, 4.69, 5.95, 6.17, 6.17, 4.75] },
      dark: { clear: [4.94, 4.94, 10.08, 9.22, 9.22, 4.57], medium: [4.77, 4.77, 7.79, 7.77, 7.77, 4.76], firm: [5.47, 5.47, 6.93, 7.14, 7.14, 5.57] },
    };
    for (const theme of ["light", "dark"] as Theme[]) for (const step of STEPS) {
      expect(surfaces.map(surface => kelp(theme, step, surface)), `${theme} ${step}`).toEqual(measured[theme][step]);
    }
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

  it("fails on a step 6 points thinner by day or by night, and on its quiet ink left unstepped", () => {
    const fails = (css: string, theme: Theme, step: Step) =>
      below(readings(css)).some(line => line.startsWith(`liquid kelp ${theme} standard ${step} glass-panel fill`));
    for (const theme of ["light", "dark"] as Theme[]) for (const step of STEPS) {
      if (theme === "dark" && step === "firm") continue;
      expect(thinner(theme, step, 6)).not.toBe(LIQUID_CSS);
      expect(fails(thinner(theme, step, 6), theme, step), `${theme} ${step} thinner`).toBe(true);
      expect(unstepped(theme, step)).not.toBe(LIQUID_CSS);
      expect(fails(unstepped(theme, step), theme, step), `${theme} ${step} unstepped`).toBe(true);
    }
    // Firm by night keeps the Color's own grey and holds with room to spare: six points thinner it still reads,
    // twelve thinner (Medium's fill) it does not.
    expect(fails(thinner("dark", "firm", 6), "dark", "firm")).toBe(false);
    expect(fails(thinner("dark", "firm", 12), "dark", "firm")).toBe(true);
    const unpicked = LIQUID_CSS.replace("--fg-muted: var(--liquid-fg-muted);", "");
    expect(unpicked).not.toBe(LIQUID_CSS);
    expect(fails(unpicked, "light", "clear")).toBe(true);
    const paperThin = PAPER_CSS.replace("--surface-page-card-fill: color-mix(in oklab, var(--bg-panel) 96%, var(--bg));",
      "--surface-page-card-fill: color-mix(in srgb, var(--bg-panel) 30%, transparent);");
    expect(paperThin).not.toBe(PAPER_CSS);
    expect(below(readings(LIQUID_CSS, paperThin)).some(line => line.startsWith("paper kelp light standard clear page-card fill"))).toBe(true);
  });
});
