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

/** A conditional block, one level deep: an at-rule and the rules inside it. */
const CONDITIONAL = /@(?:media|supports)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g;
const LOOK_CSS = readFileSync("src/app/look.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The one conditional rule, the stylesheet's named exception: when the
 * computer asks for less transparency or more contrast, the glass fill
 * goes opaque. Every other rule is keyed by the picks. */
const OPAQUE_ON_REQUEST = "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)";
const LOOK = rules(LOOK_CSS.replace(CONDITIONAL, ""));
const GLOBALS = rules(readFileSync("src/app/globals.css", "utf8"));

const DEFAULT_LIGHT = "[data-look-default]";
const DEFAULT_DARK = ':root[data-theme="dark"] [data-look-default=""]';
/** A scope that names the dark theme keeps it on a light page; one naming
 * the light theme is reached by the light scope alone. */
const DEFAULT_NAMED_DARK = ':root [data-look-default="dark"]';
const isDefaultScope = (rule: Rule) => [DEFAULT_LIGHT, DEFAULT_DARK, DEFAULT_NAMED_DARK].includes(rule.selector);
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

/** The corners' family, and the in-between corners derived from it, at
 * the pixel values their readers wrote before they read a token. */
const FAMILY = ["--radius-sm", "--radius", "--radius-control", "--radius-lg", "--radius-card", "--radius-rail"];
const TODAY: Record<string, number> = {
  "--radius-sm": 4, "--radius": 9, "--radius-control": 12, "--radius-lg": 14, "--radius-card": 20, "--radius-rail": 18,
  "--radius-chip": 3, "--radius-spine": 5, "--radius-key": 6, "--radius-item": 7, "--radius-row": 8, "--radius-box": 10,
  "--radius-tile": 11, "--radius-stage": 13, "--radius-legend": 16,
};
/** Every radius token a Corners pick re-tunes: the whole set but the pill. */
const RADIUS_TOKENS = Object.keys(TODAY).sort();

/** Token blocks applied in order, a later one winning, as rules on one element. */
const layered = (...blocks: Map<string, string>[]) => new Map(blocks.flatMap(tokens => [...tokens]));
/** A radius token's value in px on an element that declares `tokens`: a
 * literal, or a calc over another token plus or minus a literal. A custom
 * property's references resolve where it is declared, so a token this
 * element does not declare is the parent's computed value (`inherited`),
 * never re-resolved against this element's own family. */
function resolvePx(tokens: Map<string, string>, token: string, inherited: Map<string, number> = new Map(), depth = 0): number {
  const value = tokens.get(token);
  if (value === undefined) {
    const from = inherited.get(token);
    if (from === undefined) throw new Error(`${token} is not defined`);
    return from;
  }
  if (depth > 4) throw new Error(`${token} refers too deep`);
  const literal = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (literal) return Number(literal[1]);
  const derived = /^calc\(var\((--[\w-]+)\) ([-+]) (\d+(?:\.\d+)?)px\)$/.exec(value);
  if (!derived) throw new Error(`${token}: ${value} is neither a literal nor a calc over a token`);
  const base = resolvePx(tokens, derived[1], inherited, depth + 1);
  return derived[2] === "+" ? base + Number(derived[3]) : base - Number(derived[3]);
}
/** Every radius token's computed px on an element. */
const computedPx = (tokens: Map<string, string>, inherited?: Map<string, number>) =>
  new Map(Object.keys(TODAY).map(token => [token, resolvePx(tokens, token, inherited)]));

/** Every flat rule of a stylesheet with its declarations as written. */
function bodies(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
    selectors.split(",").map(selector => ({ selector: selector.trim().replace(/\s+/g, " "), body })));
}

/** The declarations of one rule body, property to value as written. */
const declared = (body: string) => new Map([...body.matchAll(/([-\w]+)\s*:\s*([^;]+);?/g)]
  .map(([, property, value]) => [property, value.trim().replace(/\s+/g, " ")]));

/** The text properties an element takes from its parent when nothing sets
 * them on the element itself. */
const INHERITED_TEXT = new Set(["color", "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "font-stretch", "font-kerning", "font-feature-settings", "font-variation-settings", "line-height", "letter-spacing",
  "word-spacing", "text-align", "text-indent", "text-transform", "text-rendering", "text-shadow", "white-space",
  "direction", "hyphens", "overflow-wrap", "word-break", "tab-size", "-webkit-font-smoothing", "-moz-osx-font-smoothing"]);

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

  it("changes the face of what is read and the corners' whole family, never the wordmark, the mono face or the pills", () => {
    expect(names(block(["font=system"], false))).toEqual(["--font-ui"]);
    expect(names(block(["corners=soft"], false))).toEqual(RADIUS_TOKENS);
    // The complete set: every radius token the page defines but the pill.
    expect(RADIUS_TOKENS).toEqual([...GLOBAL_LIGHT.tokens.keys()].filter(token => token.startsWith("--radius") && token !== "--radius-pill").sort());
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
    // A scope naming the dark theme is the same declaration, not a copy that could drift.
    expect(LOOK.find(rule => rule.selector === DEFAULT_NAMED_DARK)?.tokens).toBe(dark.tokens);
  });

  it("restates in the default scope every inherited text property the page sets on its body, in both themes", () => {
    // The body computes its text colour and face from the person's tokens,
    // and an element inherits the computed value, not the token: restating
    // the tokens alone would leave an image in the person's text colour
    // and face. Restated over the scope's own tokens, they resolve to the
    // theme's default.
    const page = new Map(bodies(readFileSync("src/app/globals.css", "utf8"))
      .filter(rule => rule.selector === "body")
      .flatMap(rule => [...declared(rule.body)])
      .filter(([property]) => INHERITED_TEXT.has(property)));
    expect([...page.keys()]).toEqual(expect.arrayContaining(["color", "font-family"]));
    const scope = (selector: string) => {
      const found = bodies(readFileSync("src/app/look.css", "utf8")).filter(rule => rule.selector === selector);
      expect(found.length, selector).toBe(1);
      return declared(found[0].body);
    };
    const light = scope(DEFAULT_LIGHT), dark = scope(DEFAULT_DARK);
    for (const [property, value] of page) expect(light.get(property), property).toBe(value);
    // The light scope matches under either theme; the dark one re-sets
    // tokens only, so the same declarations read the dark defaults.
    for (const property of page.keys()) expect(dark.has(property), `dark ${property}`).toBe(false);
  });

  it("derives every in-between corner from the family: today's values by default and in the default scope, tighter under Soft", () => {
    const soft = block(["corners=soft"], false)!;
    const scope = LOOK.find(rule => rule.selector === DEFAULT_LIGHT)!;
    // The root by default and under Soft; inside the default scope while
    // Soft is picked, where only what the scope declares is resolved anew.
    const byDefault = computedPx(GLOBAL_LIGHT.tokens);
    const underSoft = computedPx(layered(GLOBAL_LIGHT.tokens, soft.tokens));
    const inScope = computedPx(scope.tokens, underSoft);
    for (const [token, px] of Object.entries(TODAY)) {
      expect(byDefault.get(token), token).toBe(px);
      expect(inScope.get(token), `${token} in the default scope`).toBe(px);
      expect(underSoft.get(token), `${token} under Soft`).toBeLessThan(px);
    }
    // The in-between corners are written over the family, never as their own literal.
    for (const token of Object.keys(TODAY).filter(token => !FAMILY.includes(token))) {
      for (const tokens of [GLOBAL_LIGHT.tokens, soft.tokens, scope.tokens]) {
        expect(tokens.get(token), token).toMatch(/^calc\(var\(--radius[\w-]*\) [-+] \d+px\)$/);
      }
    }
    // As the approved map page draws them under Soft.
    expect(Object.fromEntries(["--radius-chip", "--radius-spine", "--radius-tile", "--radius-stage", "--radius-legend"]
      .map(token => [token, underSoft.get(token)]))).toEqual({
      "--radius-chip": 2, "--radius-spine": 4, "--radius-tile": 9, "--radius-stage": 10, "--radius-legend": 13 });
  });

  it("reads every rounded edge of a component through the radius tokens; only pills, rounds and hairline tips stay literal", () => {
    const corner = (file: string, selector: string) => bodies(readFileSync(file, "utf8"))
      .filter(rule => rule.selector === selector).map(rule => declared(rule.body).get("border-radius")).filter(Boolean);
    // The two most prominent controls over a map.
    expect(corner("src/components/map/LegendPanel.module.css", ".legend")).toEqual(["var(--radius-legend)"]);
    expect(corner("src/components/map/StageStack.module.css", ".stageBtn")).toEqual(["var(--radius-stage)"]);
    // A pill (999px, or the 99px a few pills write), a round mark, none, or the
    // 2 px-and-under tip of a bar, a track or a grip: a mark, not a rounded edge.
    const KEPT = new Set(["999px", "99px", "50%", "0", "0px", "1px", "1.5px", "2px"]);
    const literal = moduleSheets("src").filter(file => file.endsWith(".module.css")).flatMap(file =>
      bodies(readFileSync(file, "utf8")).flatMap(rule => [...declared(rule.body)]
        .filter(([property, value]) => /^border(-[a-z]+){0,2}-radius$/.test(property) && !/var\(--/.test(value)
          && !value.split(/\s+/).every(part => KEPT.has(part)))
        .map(([, value]) => `${file} ${rule.selector}: ${value}`)));
    expect(literal).toEqual([]);
  });

  it("keeps the radius family at the literals its readers held, so Rounded is today's corners", () => {
    // Module stylesheets read these tokens where they once wrote the literal
    // of the same value; the rail has its own token at its own radius.
    const family = { "--radius-sm": "4px", "--radius": "9px", "--radius-control": "12px", "--radius-lg": "14px",
      "--radius-card": "20px", "--radius-rail": "18px", "--radius-pill": "999px" };
    for (const [token, value] of Object.entries(family)) expect(GLOBAL_LIGHT.tokens.get(token), token).toBe(value);
    const rail = bodies(readFileSync("src/app/(workspace)/layout.module.css", "utf8"))
      .filter(rule => rule.selector === ".rail" && /border-radius/.test(rule.body));
    expect(rail.length).toBe(1);
    expect(rail[0].body).toMatch(/border-radius:\s*var\(--radius-rail\)/);
  });

  it("makes the glass fill opaque on request, on the root, a published page's dark root and the pictures, never an image's default scope", () => {
    const conditional = [...LOOK_CSS.matchAll(CONDITIONAL)].map(([block]) => block);
    expect(conditional).toHaveLength(1);
    const head = conditional[0].slice(0, conditional[0].indexOf("{")).trim().replace(/\s+/g, " ");
    expect(head).toBe(OPAQUE_ON_REQUEST);
    const inside = bodies(conditional[0].slice(conditional[0].indexOf("{") + 1, -1));
    const scopes = [...new Set(inside.map(rule => rule.selector))];
    expect(scopes).toEqual([":root", '[data-view-theme="dark"]', "[data-picture-color]", "[data-picture-contrast]",
      "[data-picture-corners]", "[data-picture-panels]"]);
    for (const rule of inside) expect([...declared(rule.body)], rule.selector).toEqual([["--fill-glass", "var(--bg-panel)"]]);
    // Every element the roles' block is declared on but an image's default
    // scope, whose own declaration keeps the image translucent as the default draws it.
    const block = bodies(readFileSync("src/app/globals.css", "utf8")).filter(rule => /--surface-menu-shadow/.test(rule.body));
    expect(block.map(rule => rule.selector).filter(selector => selector !== "[data-look-default]")).toEqual(scopes);
  });

  it("is loaded by the document after the global tokens it overrides", () => {
    const document = readFileSync("src/app/document.tsx", "utf8");
    const globals = document.indexOf('import "./globals.css";'), look = document.indexOf('import "./look.css";');
    expect(globals).toBeGreaterThan(-1);
    expect(look).toBeGreaterThan(globals);
  });
});
