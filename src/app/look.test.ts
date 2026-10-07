import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOK_KEYS, lookChoices, type LookKey } from "@/lib/look";

/**
 * The look stylesheet, read as the browser would: rules keyed by the
 * root's data-look-* attributes setting tokens, and one default scope that
 * puts every one of those tokens back at its theme's default for what an
 * image is made of. The token values themselves are judged by eye against
 * the approved pictures; what is held here is the shape that keeps a pick
 * whole in both themes and away from status and data colours.
 */

type Rule = { selector: string; tokens: Map<string, string> };

/** Every flat rule of a stylesheet, comments removed, in source order. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = new Map<string, string>();
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) {
      tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    }
    for (const selector of match[1].split(",")) out.push({ selector: selector.trim().replace(/\s+/g, " "), tokens });
  }
  return out;
}

const LOOK = rules(readFileSync("src/app/look.css", "utf8"));
const GLOBALS = rules(readFileSync("src/app/globals.css", "utf8"));

const DEFAULT_LIGHT = "[data-look-default]";
const DEFAULT_DARK = ':root[data-theme="dark"] [data-look-default]';
const isDefaultScope = (rule: Rule) => rule.selector === DEFAULT_LIGHT || rule.selector === DEFAULT_DARK;
const pickRules = LOOK.filter(rule => !isDefaultScope(rule));
const isDark = (rule: Rule) => rule.selector.includes('[data-theme="dark"]');

/** The picks a selector is keyed by, as `key=value`. */
const keyedBy = (selector: string) =>
  [...selector.matchAll(/\[data-look-([\w-]+)="([^"]*)"\]/g)].map(([, key, value]) => `${key}=${value}`).sort();
const block = (picks: string[], dark: boolean) => pickRules.find(rule =>
  isDark(rule) === dark && JSON.stringify(keyedBy(rule.selector)) === JSON.stringify([...picks].sort()));
const names = (rule: Rule | undefined) => [...(rule?.tokens.keys() ?? [])].sort();

/** The interface family a Color re-hues, in both themes. */
const COLOR_TOKENS = ["--accent", "--accent-bright", "--accent-dim", "--accent-wash", "--bg", "--bg-hover", "--bg-panel",
  "--bg-raised", "--border", "--border-strong", "--divider", "--fg", "--fg-faint", "--fg-muted", "--focus", "--on-accent",
  "--shadow", "--swatch-border"];
/** What More contrast strengthens, in both themes. */
const CONTRAST_TOKENS = ["--border", "--border-strong", "--divider", "--fg-faint", "--fg-muted"];
/** Status and data colours: no pick ever sets one. */
const NEVER = /^--(health|warn|danger|grp-|source-|note-|code-|verb-|graticule|entry-)/;

const globalBlock = (selector: string) => GLOBALS.find(rule => rule.selector === selector)!;
const GLOBAL_LIGHT = globalBlock(":root"), GLOBAL_DARK = globalBlock(':root[data-theme="dark"]');

describe("the look stylesheet", () => {
  it("keys every rule on the document root by picks and choices the catalogue offers, never a default", () => {
    expect(pickRules.length).toBeGreaterThan(10);
    for (const rule of pickRules) {
      expect(rule.selector, rule.selector).toMatch(/^:root(\[data-theme="dark"\])?(\[data-look-[\w-]+="[^"]*"\])+$/);
      const picks = keyedBy(rule.selector);
      expect(picks.length, rule.selector).toBeGreaterThan(0);
      for (const pick of picks) {
        const [key, value] = pick.split("=") as [LookKey, string];
        expect(LOOK_KEYS, rule.selector).toContain(key);
        expect(lookChoices(key), rule.selector).toContain(value);
        // Today's look carries no attribute, so a rule keyed by a default never matches.
        expect(value, rule.selector).not.toBe(lookChoices(key)[0]);
      }
    }
  });

  it("gives every Color one block per theme, every block setting the same interface tokens", () => {
    const others = lookChoices("color").slice(1);
    expect(others).toEqual(["harbor", "heather", "slate"]);
    for (const color of others) {
      for (const dark of [false, true]) {
        expect(names(block([`color=${color}`], dark)), `${color} ${dark ? "dark" : "light"}`).toEqual(COLOR_TOKENS);
      }
    }
  });

  it("restates More contrast per Color, Kelp included, in both themes, over the same tokens", () => {
    for (const color of lookChoices("color")) {
      const picks = color === "kelp" ? ["contrast=more"] : [`color=${color}`, "contrast=more"];
      for (const dark of [false, true]) {
        expect(names(block(picks, dark)), `${color} more ${dark ? "dark" : "light"}`).toEqual(CONTRAST_TOKENS);
      }
    }
  });

  it("changes the face of what is read and the corners' family, never the wordmark, the mono face or the pills", () => {
    expect(names(block(["font=system"], false))).toEqual(["--font-ui"]);
    expect(names(block(["corners=soft"], false))).toEqual(["--radius", "--radius-card", "--radius-control", "--radius-lg", "--radius-sm"]);
    const set = new Set(pickRules.flatMap(rule => names(rule)));
    for (const kept of ["--font-display", "--font-mono", "--radius-pill"]) expect(set.has(kept), kept).toBe(false);
  });

  it("sets no data, health, warning or danger token in any rule", () => {
    const set = [...new Set(pickRules.flatMap(rule => names(rule)))];
    expect(set.filter(token => NEVER.test(token))).toEqual([]);
    // The health marks read their own token, which no pick sets.
    expect(GLOBAL_LIGHT.tokens.get("--health-ok")).toBe("#0d7d5c");
    expect(GLOBAL_DARK.tokens.get("--health-ok")).toBe("#45c58f");
    for (const file of ["src/components/HealthDot.module.css", "src/components/settings/SystemTab.module.css"]) {
      const marks = rules(readFileSync(file, "utf8")).filter(rule => /data-state="(ready|on)"/.test(rule.selector));
      expect(marks.length, file).toBe(1);
      const source = readFileSync(file, "utf8").split(marks[0].selector)[1].split("}")[0];
      expect(source, file).toContain("var(--health-ok)");
      expect(source, file).not.toContain("var(--accent");
    }
  });

  it("restates in the default scope every token a pick sets, at the theme's default value", () => {
    const light = LOOK.find(rule => rule.selector === DEFAULT_LIGHT)!, dark = LOOK.find(rule => rule.selector === DEFAULT_DARK)!;
    const set = [...new Set(pickRules.flatMap(rule => names(rule)))].sort();
    expect(set.length).toBeGreaterThan(20);
    expect(names(light)).toEqual(set);
    // The dark scope restates what the dark theme gives another value.
    expect(names(dark)).toEqual(set.filter(token => GLOBAL_DARK.tokens.has(token)));
    for (const token of set) expect(light.tokens.get(token), token).toBe(GLOBAL_LIGHT.tokens.get(token));
    for (const token of names(dark)) expect(dark.tokens.get(token), token).toBe(GLOBAL_DARK.tokens.get(token));
  });

  it("is loaded by the document after the global tokens it overrides", () => {
    const document = readFileSync("src/app/document.tsx", "utf8");
    const globals = document.indexOf('import "./globals.css";'), look = document.indexOf('import "./look.css";');
    expect(globals).toBeGreaterThan(-1);
    expect(look).toBeGreaterThan(globals);
  });
});
