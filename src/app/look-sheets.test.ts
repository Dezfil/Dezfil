import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookChoices, type LookKey } from "@/lib/look";

/**
 * The look's backgrounds: the Atlantic chart, the Graticule and the Hex
 * lattice, each a file per Color and theme with the inks baked in, and the
 * stylesheet choosing one by Color, Background and theme (Plain is no
 * image). Held here: every variant is its pattern's geometry with only the
 * approved inks swapped, Kelp's chart is the shipped file untouched, the
 * committed files are what the generator writes, and the cascade picks the
 * right file in every combination without leaning on source order.
 */

/** The approved inks, `r,g,b` per Color and theme: the base draws the
 * lines, the accent tints the chart's highlighted course. */
const INKS: Record<string, Record<"light" | "dark", { base: string; accent: string }>> = {
  kelp: { light: { base: "36,50,48", accent: "20,80,64" }, dark: { base: "151,170,205", accent: "140,180,165" } },
  harbor: { light: { base: "41,47,56", accent: "44,70,104" }, dark: { base: "143,172,208", accent: "153,171,198" } },
  heather: { light: { base: "48,45,56", accent: "71,61,100" }, dark: { base: "170,164,202", accent: "171,165,195" } },
  slate: { light: { base: "43,47,53", accent: "62,70,77" }, dark: { base: "161,170,184", accent: "167,170,174" } },
};
const THEMES = ["light", "dark"] as const;
const COLORS = lookChoices("color");
/** The shipped sheets, byte for byte as they were before the look existed. */
const SHIPPED = {
  light: { file: "public/shell-sheet-light.svg", sha256: "0859fb373de59a3f30fcb40c879feafb7f415a7d4bc103d7d17d22cf7d8d64be" },
  dark: { file: "public/shell-sheet-dark.svg", sha256: "c6055a32f496ef5450971d913efc3911ef434f1f162e7dc76f9bd78afcc0479c" },
};
/** Each tiled pattern's size, which the stylesheet's sheet size must equal. */
const TILES = { graticule: { width: "88", height: "88" }, hex: { width: "31.177", height: "54" } } as const;

const served = (pattern: string, color: string, theme: string) =>
  pattern === "atlantic" && color === "kelp" ? `/shell-sheet-${theme}.svg` : `/look/${pattern}-${color}-${theme}.svg`;
const read = (servedPath: string) => readFileSync(`public${servedPath}`, "utf8");
/** A variant with its own Color's inks named rather than spelled. Any other
 * ink is left as it is, so a wrong one cannot normalize away. */
const normalized = (svg: string, color: string, theme: "light" | "dark") =>
  svg.split(`rgba(${INKS[color][theme].base},`).join("rgba(BASE,").split(`rgba(${INKS[color][theme].accent},`).join("rgba(ACCENT,");

describe("the sheet files", () => {
  it("keep the two shipped sheets byte for byte, Kelp's Atlantic chart in each theme", () => {
    for (const theme of THEMES) {
      const bytes = readFileSync(SHIPPED[theme].file);
      expect(createHash("sha256").update(bytes).digest("hex"), SHIPPED[theme].file).toBe(SHIPPED[theme].sha256);
    }
  });

  it("make every Atlantic variant the shipped chart of its theme with only the inks swapped", () => {
    for (const theme of THEMES) {
      const source = normalized(read(`/shell-sheet-${theme}.svg`), "kelp", theme);
      expect(source).toContain("rgba(BASE,");
      expect(source).toContain("rgba(ACCENT,");
      for (const color of COLORS) {
        const variant = normalized(read(served("atlantic", color, theme)), color, theme);
        expect(variant === source, `atlantic ${color} ${theme}`).toBe(true);
      }
    }
  });

  it.each(Object.entries(TILES))("make every %s variant one tile with only the base ink swapped", (pattern, size) => {
    const reference = normalized(read(served(pattern, "kelp", "light")), "kelp", "light");
    expect(reference).toContain(`width='${size.width}' height='${size.height}'`);
    expect(reference).toContain("rgba(BASE,");
    expect(reference).not.toMatch(/rgba\(\d/);
    for (const color of COLORS) for (const theme of THEMES) {
      const variant = normalized(read(served(pattern, color, theme)), color, theme);
      expect(variant === reference, `${pattern} ${color} ${theme}`).toBe(true);
    }
  });

  it("are exactly what the generator writes, and nothing else is in its folder", () => {
    const expected = new Set(COLORS.flatMap(color => THEMES.flatMap(theme => ["atlantic", "graticule", "hex"]
      .map(pattern => served(pattern, color, theme)).filter(file => file.startsWith("/look/")))));
    expect(new Set(readdirSync("public/look").map(name => `/look/${name}`))).toEqual(expected);
    expect(execFileSync("node", ["scripts/generate-look-sheets.mjs", "--check"], { encoding: "utf8" })).toContain("PASS");
  });
});

/* ---- the cascade, as the browser resolves it on the document root ---- */

type Rule = { selector: string; specificity: number; order: number; tokens: Map<string, string> };

/** The rules that can set a token on the root: `:root` and attribute selectors only. */
function rootRules(css: string, offset: number): Rule[] {
  const out: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let order = offset;
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = new Map<string, string>();
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    order += 1;
    for (const raw of match[1].split(",")) {
      const selector = raw.trim().replace(/\s+/g, " ");
      if (!/^:root(\[[\w-]+="[^"]*"\])*$/.test(selector)) continue;
      out.push({ selector, specificity: 1 + (selector.match(/\[/g)?.length ?? 0), order, tokens });
    }
  }
  return out;
}
const RULES = [...rootRules(readFileSync("src/app/globals.css", "utf8"), 0), ...rootRules(readFileSync("src/app/look.css", "utf8"), 100_000)];
const matches = (selector: string, root: Record<string, string>) =>
  [...selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(([, name, value]) => root[name] === value);

/** The token's value on a root, and every rule tied at the winning specificity. */
function resolve(token: string, root: Record<string, string>) {
  const candidates = RULES.filter(rule => rule.tokens.has(token) && matches(rule.selector, root));
  const top = Math.max(...candidates.map(rule => rule.specificity));
  const tied = candidates.filter(rule => rule.specificity === top);
  const winner = tied.reduce((a, b) => (b.order > a.order ? b : a));
  return { value: winner.tokens.get(token)!, tiedValues: new Set(tied.map(rule => rule.tokens.get(token))) };
}

/** Every root a person can have: each theme and each combination of picks
 * the stylesheet keys on, only the picks that differ from the default stamped. */
function roots(): Record<string, string>[] {
  const out: Record<string, string>[] = [{}];
  const picks: LookKey[] = ["color", "contrast", "font", "background", "corners"];
  const axes: [string, readonly string[]][] = [["data-theme", ["", "dark"]],
    ...picks.map(key => [`data-look-${key}`, ["", ...lookChoices(key).slice(1)]] as [string, readonly string[]])];
  for (const [name, values] of axes) {
    const next: Record<string, string>[] = [];
    for (const root of out) for (const value of values) next.push(value ? { ...root, [name]: value } : root);
    out.splice(0, out.length, ...next);
  }
  return out;
}

describe("the sheet the stylesheet picks", () => {
  const all = roots();

  it("covers every combination of theme and pick", () => {
    expect(all).toHaveLength(2 * 4 * 2 * 2 * 4 * 2);
  });

  it("is the Color's chart, the Color's tile or none, in the theme's ink, for every combination", () => {
    for (const root of all) {
      const theme = root["data-theme"] === "dark" ? "dark" : "light";
      const color = root["data-look-color"] ?? "kelp", background = root["data-look-background"] ?? "atlantic";
      const label = JSON.stringify(root);
      const sheet = resolve("--sheet", root).value;
      if (background === "plain") {
        expect(sheet, label).toBe("none");
        continue;
      }
      expect(sheet, label).toBe(`url("${served(background, color, theme)}")`);
      const tile = TILES[background as keyof typeof TILES];
      expect(resolve("--sheet-size", root).value, label).toBe(tile ? `${tile.width}px ${tile.height}px` : "cover");
      expect(resolve("--sheet-repeat", root).value, label).toBe(tile ? "repeat" : "no-repeat");
      expect(resolve("--sheet-pos", root).value, label).toBe(tile ? "0 0" : "center");
    }
  });

  it("never leaves a token to source order: rules tied at the top agree, for every token and combination", () => {
    const tokens = new Set(RULES.flatMap(rule => [...rule.tokens.keys()]));
    for (const root of all) for (const token of tokens) {
      if (!RULES.some(rule => rule.tokens.has(token) && matches(rule.selector, root))) continue;
      expect(resolve(token, root).tiedValues.size, `${token} ${JSON.stringify(root)}`).toBe(1);
    }
  });

  it("names only files that exist", () => {
    const css = readFileSync("src/app/look.css", "utf8") + readFileSync("src/app/globals.css", "utf8");
    const urls = [...css.matchAll(/url\("(\/[^"]+)"\)/g)].map(match => match[1]);
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) expect(existsSync(`public${url}`), url).toBe(true);
  });
});
