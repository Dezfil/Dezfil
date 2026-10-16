import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A notice's words against its own fill. The warning and the failure note
 * draw their tone's colour as text on that tone's dim fill, laid over the
 * panel they sit on; the words must read at 4.5:1 or better there, in
 * both themes. Every value is read from the live stylesheets: which
 * tokens the note draws from its own stylesheet, the tokens' values from
 * the page's root and its dark theme. The ratios are printed for the
 * record.
 */

type RGBA = [number, number, number, number];
type Theme = "light" | "dark";

const GLOBALS = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const NOTE = readFileSync("src/components/ui/ErrorNote.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the top-level rule whose selector list is exactly this
 * one, a cascade layer's rule included. */
function block(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const m = new RegExp(`(?:^|\\}|@layer [\\w-]+\\s*\\{)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} is not where this check expects it`).not.toBeNull();
  return new Map([...m![1].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim()]));
}

/** The tokens in force in a theme: the root's, then the dark theme's over them. */
function tokens(theme: Theme): Map<string, string> {
  const root = block(GLOBALS, ":root");
  if (theme === "light") return root;
  return new Map([...root, ...block(GLOBALS, ':root[data-theme="dark"],\n[data-view-theme="dark"]')]);
}

function colour(value: string, scope: Map<string, string>): RGBA {
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) {
    const next = scope.get(reference[1]);
    expect(next, `${reference[1]} is declared`).toBeDefined();
    return colour(next!, scope);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(1) as RGBA;
  const rgba = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((part) => part.trim());
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
  }
  throw new Error(`${value}: not a colour this reading knows`);
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: RGBA) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** A translucent fill over an opaque ground. */
const over = (top: RGBA, under: RGBA): RGBA =>
  [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA;

/** The note's words over its fill over the panel, for a tone's rule. */
function ratio(selector: string, theme: Theme): number {
  const scope = tokens(theme);
  const rule = block(NOTE, selector);
  const text = colour(rule.get("color")!, scope);
  const fill = colour(rule.get("background")!, scope);
  expect(text[3], `${selector}: the words are opaque`).toBe(1);
  return contrast(text, over(fill, colour("var(--bg-panel)", scope)));
}

const TONES = [
  ["the warning note", '.note[data-tone="warn"]'],
  ["the failure note", ".note"],
] as const;

describe("a notice's words on its own fill over the panel", () => {
  it.each(TONES.flatMap(([name, selector]) => (["light", "dark"] as const).map((theme) => [name, selector, theme] as const)))(
    "%s reads at 4.5:1 or better (%s, %s theme)",
    (name, selector, theme) => {
      const value = ratio(selector, theme);
      console.log(`${name}, ${theme}: ${value.toFixed(2)}:1`);
      expect(value).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("reads each tone's fill as its own colour, dimmed", () => {
    for (const theme of ["light", "dark"] as const) {
      const scope = tokens(theme);
      for (const tone of ["warn", "danger"]) {
        const [r, g, b] = colour(`var(--${tone})`, scope);
        const dim = colour(`var(--${tone}-dim)`, scope);
        expect(dim.slice(0, 3), `--${tone}-dim, ${theme}`).toEqual([r, g, b]);
        expect(dim[3], `--${tone}-dim, ${theme}`).toBeLessThan(1);
      }
    }
  });
});
