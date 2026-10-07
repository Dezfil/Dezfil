import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

/** The interface family a Color re-hues, and its Atlantic chart, in both themes. */
const COLOR_TOKENS = ["--accent", "--accent-bright", "--accent-dim", "--accent-wash", "--bg", "--bg-hover", "--bg-panel",
  "--bg-raised", "--border", "--border-strong", "--divider", "--fg", "--fg-faint", "--fg-muted", "--focus", "--on-accent",
  "--shadow", "--sheet", "--swatch-border"];
/** What More contrast strengthens, in both themes. */
const CONTRAST_TOKENS = ["--border", "--border-strong", "--divider", "--fg-faint", "--fg-muted"];
/** Status and data colours: no pick ever sets one. */
const NEVER = /^--(on-health|health|warn|danger|grp-|source-|note-|code-|verb-|graticule|entry-)/;

const globalBlock = (selector: string) => GLOBALS.find(rule => rule.selector === selector)!;
const GLOBAL_LIGHT = globalBlock(":root"), GLOBAL_DARK = globalBlock(':root[data-theme="dark"]');

/** Every flat rule of a stylesheet with its declarations as written. */
function bodies(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
    selectors.split(",").map(selector => ({ selector: selector.trim().replace(/\s+/g, " "), body })));
}

function moduleSheets(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) return moduleSheets(file);
    return file.endsWith(".css") ? [file.split(path.sep).join("/")] : [];
  });
}

/**
 * The status marks: a service's health, an "ok" outcome and a "live"
 * state. They read the status family, today's kelp kept apart from the
 * accent, so the person's Color never repaints one, as it never repaints
 * a warning or a danger mark. Activity (running, in progress) is the
 * interface's and stays on the accent.
 */
const STATUS_MARKS: [file: string, selector: string][] = [
  ["src/components/HealthDot.module.css", '.dot[data-state="ready"]'],
  ["src/components/settings/SystemTab.module.css", '.state[data-state="on"]::before'],
  ["src/components/WorkflowStatusChip.module.css", '.stateChip[data-tone="ok"]'],
  ["src/components/WorkflowStatusChip.module.css", '.stateChip[data-tone="ok"] i'],
  ["src/components/workflow-canvas/WorkflowCanvas.module.css", '.tBadge[data-s="check"]'],
  ["src/components/workflow-canvas/ResultsBand.module.css", '.entry[data-lv="ok"] .lv'],
  ["src/components/connections/ConnectionStatus.module.css", ".pill"],
  ["src/components/connections/ConnectionForm.module.css", '.result > span[data-state="ok"]'],
  ["src/components/connections/PostgisPane.module.css", ".bigCheck"],
  ["src/components/gallery.module.css", ".chip[data-live]"],
  ["src/components/gallery.module.css", ".chip[data-live] i"],
  ["src/components/builder/publish/PublishPopover.module.css", ".liveDot"],
  ["src/components/ui/Status.module.css", ".dot[data-live]::before"],
  ["src/components/builder/CustomBasemapSection.module.css", '.verdict[data-tone="ok"]'],
  ["src/components/sql/SqlConsole.module.css", ".cardStatus"],
  ["src/components/builder/AssistantPanel.module.css", ".lineStatus"],
];
/** A selector naming an ok or live state, wherever it is written. */
const OK_OR_LIVE = /\[data-(?:tone|state|lv|status|s)="(?:ok|ready|on|check|succeeded|valid)"\]|\[data-live\]/;
const READS_ACCENT = /var\(--(?:on-)?accent/;

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
  });

  it("keeps every status mark (health, ok, live) on the status family, never the accent", () => {
    const onAccent = STATUS_MARKS.flatMap(([file, selector]) => {
      const marks = bodies(readFileSync(file, "utf8")).filter(rule => rule.selector === selector);
      expect(marks.length, `${file} ${selector}`).toBe(1);
      return READS_ACCENT.test(marks[0].body) || !/var\(--(?:on-)?health-ok/.test(marks[0].body) ? [`${file} ${selector}`] : [];
    });
    expect(onAccent).toEqual([]);
    // And any other rule naming an ok or live state, so a new one cannot slip back.
    const offenders = moduleSheets("src").flatMap(file => bodies(readFileSync(file, "utf8"))
      .filter(rule => OK_OR_LIVE.test(rule.selector) && READS_ACCENT.test(rule.body))
      .map(rule => `${file} ${rule.selector}`));
    expect(offenders).toEqual([]);
    // The family is today's kelp in both themes, so Dezfil's default look is unchanged.
    for (const [status, accent] of [["--health-ok", "--accent"], ["--health-ok-bright", "--accent-bright"],
      ["--health-ok-dim", "--accent-dim"], ["--health-ok-wash", "--accent-wash"], ["--on-health-ok", "--on-accent"]]) {
      for (const theme of [GLOBAL_LIGHT, GLOBAL_DARK]) {
        expect(theme.tokens.get(status), status).toBeDefined();
        expect(theme.tokens.get(status), status).toBe(theme.tokens.get(accent));
      }
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
