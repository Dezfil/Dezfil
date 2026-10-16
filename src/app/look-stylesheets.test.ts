import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookChoices } from "@/lib/look";

/**
 * The Panels looks' stylesheets. A look restates the surface roles' parts
 * and nothing else: keyed on the workspace root by the look's pick, on the
 * pictures of the other picks (which show the
 * person's look) and on the look's own Panels picture; never a
 * component, never a forced declaration. The values are written out
 * below as the design names them, never read back from the stylesheets
 * they judge.
 */

type Theme = "light" | "dark";
type Rule = { selectors: string[]; within: string | null; body: string; declarations: [string, string][] };

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
    const body = text.slice(at + 1, close);
    out.push({
      selectors: head.split(",").map(selector => selector.trim()).filter(Boolean),
      within,
      body,
      declarations: [...body.matchAll(/([-\w]+)\s*:\s*([^;]+);?/g)].map(([, property, value]) => [property, value.trim().replace(/\s+/g, " ")]),
    });
    at = close;
    start = close + 1;
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const GLOBALS = read("src/app/globals.css");
const LIQUID_CSS = read("src/app/look-liquid.css");
const PAPER_CSS = read("src/app/look-paper.css");

const ROLE_NAMES = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "map-card", "page-card", "inner-card", "block",
  "menu", "dialog", "stage"] as const;
type Role = (typeof ROLE_NAMES)[number];

/** Each role's parts as the shipped block declares them. */
function roleParts(globals: string): Map<Role, string[]> {
  const block = rules(globals).find(rule => rule.declarations.some(([property]) => property === "--surface-menu-shadow"))!;
  const parts = new Map<Role, string[]>(ROLE_NAMES.map(role => [role, []]));
  for (const [property] of block.declarations) {
    const role = [...ROLE_NAMES].sort((a, b) => b.length - a.length).find(name => property.startsWith(`--surface-${name}-`));
    if (role) parts.get(role)!.push(property.slice(`--surface-${role}-`.length));
  }
  return parts;
}
/** A part a look leaves alone: the corner belongs to the Corners pick. */
const restates = (part: string) => part !== "corner";
/** A part that is a ground: what goes opaque on request. */
const FILL_PARTS = new Set(["fill", "fill-panel", "knob", "mark", "fill-raised"]);

/* ---- Liquid's values: one recipe for every role ---- */

/** The light on the rim, drawn inside the edge: the sides facing the light
 * (the upper left), the far side fainter, a faint glow. */
const RIM: Record<Theme, string> = {
  light: "inset 1px 1px 0 rgba(255, 255, 255, 0.9), inset -1px -1px 0 rgba(255, 255, 255, 0.405), inset 0 0 14px rgba(255, 255, 255, 0.144)",
  dark: "inset 1px 1px 0 rgba(255, 255, 255, 0.42), inset -1px -1px 0 rgba(255, 255, 255, 0.168), inset 0 0 14px rgba(255, 255, 255, 0.067)",
};
/** The soft two-layer drops, by how high a surface sits: lying inside a
 * panel, floating, and raised (under the pointer, lifted, dragged, or a
 * dialog, the topmost). */
type Height = "contact" | "float" | "high";
const DROP: Record<Theme, Record<Height, string>> = {
  light: {
    contact: "0 1px 2px color-mix(in srgb, var(--shadow) 40%, transparent), 0 4px 12px -4px color-mix(in srgb, var(--shadow) 50%, transparent)",
    float: "0 1px 1px color-mix(in srgb, var(--shadow) 20%, transparent), 0 12px 32px -6px color-mix(in srgb, var(--shadow) 85%, transparent)",
    high: "0 1px 1px color-mix(in srgb, var(--shadow) 20%, transparent), 0 24px 64px -12px var(--shadow)",
  },
  dark: {
    contact: "0 1px 2px rgba(0, 0, 0, 0.45), 0 4px 12px -4px rgba(0, 0, 0, 0.4)",
    float: "0 1px 1px rgba(0, 0, 0, 0.35), 0 14px 36px -6px rgba(0, 0, 0, 0.55)",
    high: "0 1px 1px rgba(0, 0, 0, 0.4), 0 24px 64px -12px rgba(0, 0, 0, 0.7)",
  },
};
/** The one fill: the panel tone under a tint, as one colour (by day white
 * 0.08 over 90 %, by night black 0.08 over 78 %), and the same tint over a
 * full share when it goes opaque. */
const FILL: Record<Theme, string> = {
  light: "color-mix(in srgb, #fff 8%, var(--bg-panel) 82.8%)",
  dark: "color-mix(in srgb, #000 8%, var(--bg-panel) 71.76%)",
};
const OPAQUE: Record<Theme, string> = {
  light: "color-mix(in srgb, #fff 8%, var(--bg-panel) 92%)",
  dark: "color-mix(in srgb, #000 8%, var(--bg-panel) 92%)",
};
const BLUR = "blur(24px)";
const LENS = "18";
const CLEAR = "1px solid transparent";
/** The dashed line of a card that makes something new, kept in its width with no colour. */
const DASHED_CLEAR = "1px dashed transparent";

/** Each role's parts under Liquid, with the fill it goes opaque at: every
 * ground the one fill, every blur and bend the same, no line, and the
 * shadow the rim light over the drop for the height the role sits at. */
function liquid(role: Role, theme: Theme, opaque = false): Record<string, string> {
  const lit = (height: Height) => `${RIM[theme]}, ${DROP[theme][height]}`;
  const fill = opaque ? OPAQUE[theme] : FILL[theme];
  const floating = { fill, blur: BLUR, lens: LENS };
  switch (role) {
    case "glass-chrome": case "glass-panel": case "overlay-panel": return { ...floating, edge: "none", shadow: lit("float") };
    case "overlay-control": return { ...floating, edge: "none", shadow: lit("float"), grow: "none" };
    case "map-card": return { ...floating, edge: CLEAR, shadow: lit("float") };
    case "page-card": return { ...floating, edge: CLEAR, shadow: lit("float"), "shadow-hover": lit("high"), "edge-hover": CLEAR };
    case "inner-card": return {
      ...floating, edge: CLEAR, shadow: lit("contact"), "shadow-lifted": lit("high"), "shadow-dragged": lit("high"),
      knob: fill, mark: fill, "edge-hover": CLEAR, "edge-new": DASHED_CLEAR,
    };
    case "block": return { fill, "fill-panel": fill, edge: CLEAR, shadow: lit("contact") };
    case "menu": return { ...floating, edge: CLEAR, shadow: lit("float"), "edge-strong": CLEAR, "fill-raised": fill };
    case "dialog": return { ...floating, edge: CLEAR, shadow: lit("high") };
    case "stage": return { fill: "transparent", blur: "none", edge: "none", shadow: DROP[theme].float };
  }
}

const SUPPORTS = "@supports not (backdrop-filter: blur(1px))";
const REQUEST = "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)";
/** The pictures of the other picks: they show the person's look. */
const OTHER_PICTURES = ["color", "contrast", "corners"];

const LIQUID_SELECTOR = /^:root(\[data-theme="dark"\])?\[data-look-panels="([\w-]+)"\]( \[data-picture-([\w-]+)\])?$/;
const PICTURE_SELECTOR = /^:root(\[data-theme="dark"\])? \[data-picture-panels="liquid"\]$/;

/** What is wrong with Liquid's stylesheet; empty when it holds. */
export function liquidProblems(css: string, globals: string = GLOBALS): string[] {
  const problems: string[] = [];
  const parts = roleParts(globals);
  const known = new Set([...parts].flatMap(([role, names]) => names.map(part => `--surface-${role}-${part}`)));

  // Each selector's restated parts, per condition, in source order.
  const restated = new Map<string, Map<string, string>>();
  for (const rule of rules(css)) {
    if (rule.within !== null && rule.within !== SUPPORTS && rule.within !== REQUEST) problems.push(`${rule.within}: not a condition a look keys on`);
    if (/!important/.test(rule.body)) problems.push(`${rule.selectors.join(", ")}: forces a declaration`);
    for (const selector of rule.selectors) {
      const pick = LIQUID_SELECTOR.exec(selector), picture = PICTURE_SELECTOR.exec(selector);
      if (!pick && !picture) { problems.push(`${selector}: keyed on neither the root by Liquid nor the Liquid picture`); continue; }
      if (pick && pick[2] !== "liquid") problems.push(`${selector}: ${pick[2]} is not Liquid`);
      if (pick?.[4] && !OTHER_PICTURES.includes(pick[4])) problems.push(`${selector}: dresses a picture that shows its own Panels`);
      const key = `${rule.within ?? ""}|${selector}`;
      const tokens = restated.get(key) ?? new Map<string, string>();
      for (const [property, value] of rule.declarations) {
        if (!known.has(property)) problems.push(`${selector}: declares ${property}, not a role's part`);
        tokens.set(property, value);
      }
      restated.set(key, tokens);
    }
  }

  /** Compare what a selector restates, over what it inherits from its light twin, with what it should. */
  const holds = (within: string | null, selector: string, expected: Map<string, string>, under?: string) => {
    const own = restated.get(`${within ?? ""}|${selector}`) ?? new Map<string, string>();
    const base = under ? (restated.get(`${within ?? ""}|${under}`) ?? new Map<string, string>()) : new Map<string, string>();
    const effective = new Map([...base, ...own]);
    for (const [token, value] of expected) {
      if (!effective.has(token)) problems.push(`${selector}${within ? ` within ${within}` : ""}: ${token} is not restated`);
      else if (effective.get(token) !== value) problems.push(`${selector}${within ? ` within ${within}` : ""}: ${token} is ${effective.get(token)}, not ${value}`);
    }
    for (const token of effective.keys()) {
      if (!expected.has(token)) problems.push(`${selector}${within ? ` within ${within}` : ""}: restates ${token}, which is not the recipe's`);
    }
  };
  const wanted = (theme: Theme, opaque: boolean) => new Map(ROLE_NAMES.flatMap(role => {
    const values = liquid(role, theme, opaque);
    // The stage has no ground of its own to make opaque.
    return parts.get(role)!.filter(part => restates(part) && (!opaque || (FILL_PARTS.has(part) && role !== "stage")))
      .map(part => [`--surface-${role}-${part}`, values[part] ?? "(no value named)"] as [string, string]);
  }));

  const root = (dark: boolean) => `:root${dark ? '[data-theme="dark"]' : ""}[data-look-panels="liquid"]`;
  const selectors = (dark: boolean) => [root(dark), ...OTHER_PICTURES.map(pick => `${root(dark)} [data-picture-${pick}]`),
    `:root${dark ? '[data-theme="dark"]' : ""} [data-picture-panels="liquid"]`];
  const light = selectors(false), dark = selectors(true);
  light.forEach((selector, at) => {
    holds(null, selector, wanted("light", false));
    holds(null, dark[at], wanted("dark", false), selector);
    for (const condition of [SUPPORTS, REQUEST]) {
      holds(condition, selector, wanted("light", true));
      holds(condition, dark[at], wanted("dark", true));
    }
  });
  return problems;
}

/** A shadow's layers, split at the commas outside parentheses. */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { out.push(current.trim()); current = ""; } else current += char;
  }
  return [...out, current.trim()];
}

/** Every value a part restates across the roles under Liquid on the root,
 * by the part's kind: one recipe means one value each. */
function recipeValues(css: string, theme: Theme): Record<"fill" | "blur" | "lens" | "rim", Set<string>> {
  const selector = `:root${theme === "dark" ? '[data-theme="dark"]' : ""}[data-look-panels="liquid"]`;
  const light = new Map(rules(css).filter(rule => rule.within === null && rule.selectors.includes(':root[data-look-panels="liquid"]'))
    .flatMap(rule => rule.declarations));
  const own = new Map(rules(css).filter(rule => rule.within === null && rule.selectors.includes(selector)).flatMap(rule => rule.declarations));
  const effective = new Map([...light, ...own]);
  const out = { fill: new Set<string>(), blur: new Set<string>(), lens: new Set<string>(), rim: new Set<string>() };
  for (const [property, value] of effective) {
    const role = ROLE_NAMES.find(name => property.startsWith(`--surface-${name}-`));
    if (!role || role === "stage") continue;
    const part = property.slice(`--surface-${role}-`.length);
    if (FILL_PARTS.has(part)) out.fill.add(value);
    else if (part === "blur") out.blur.add(value);
    else if (part === "lens") out.lens.add(value);
    else if (part.startsWith("shadow")) out.rim.add(layers(value).slice(0, 3).join(", "));
  }
  return out;
}

/* ---- Paper's values ---- */

/** Paper's panel: a paper white a step below the panel tone by day (4 %
 * of the ground mixed in), the raised step by night. */
const PAPER_PANEL: Record<Theme, string> = { light: "color-mix(in oklab, var(--bg-panel) 96%, var(--bg))", dark: "var(--bg-raised)" };
/** One gentle two-layer lift, a lighter one on page cards, a contact line inside panels. */
const PAPER_LIFT: Record<Theme, Record<"lift" | "card" | "inner", string>> = {
  light: {
    lift: "0 1px 1px color-mix(in srgb, var(--shadow) 40%, transparent), 0 8px 24px -4px color-mix(in srgb, var(--shadow) 70%, transparent)",
    card: "0 1px 1px color-mix(in srgb, var(--shadow) 30%, transparent), 0 6px 20px -4px color-mix(in srgb, var(--shadow) 55%, transparent)",
    inner: "0 1px 2px color-mix(in srgb, var(--shadow) 40%, transparent)",
  },
  dark: {
    lift: "0 1px 1px rgba(0, 0, 0, 0.5), 0 10px 28px -4px rgba(0, 0, 0, 0.55)",
    card: "0 1px 1px rgba(0, 0, 0, 0.45), 0 8px 24px -4px rgba(0, 0, 0, 0.45)",
    inner: "0 1px 2px rgba(0, 0, 0, 0.4)",
  },
};
/** The lines inside panels and cards: 7 % ink by day, 8 % by night. */
const PAPER_LINE: Record<Theme, string> = {
  light: "color-mix(in srgb, var(--fg) 7%, transparent)",
  dark: "color-mix(in srgb, var(--fg) 8%, transparent)",
};

/** Each role's parts under Paper; menus, dialogs, the blocks inside panels
 * and the cards over the map are as shipped. */
function paper(role: Role, theme: Theme): Record<string, string> | null {
  const sheet = { fill: PAPER_PANEL[theme], blur: "none", edge: "none", shadow: PAPER_LIFT[theme].lift };
  switch (role) {
    case "glass-chrome": case "glass-panel": case "overlay-panel": case "overlay-control": return sheet;
    case "page-card": return {
      fill: PAPER_PANEL[theme], blur: "none", edge: CLEAR, shadow: PAPER_LIFT[theme].card, "shadow-hover": PAPER_LIFT[theme].lift, "edge-hover": CLEAR,
    };
    case "inner-card": return {
      fill: theme === "light" ? "var(--bg-panel)" : "var(--bg-hover)", blur: "none", edge: CLEAR, shadow: PAPER_LIFT[theme].inner,
      "shadow-lifted": PAPER_LIFT[theme].card, "shadow-dragged": PAPER_LIFT[theme].lift, "edge-hover": CLEAR, "edge-new": DASHED_CLEAR,
    };
    case "stage": return { shadow: PAPER_LIFT[theme].lift };
    case "menu": case "dialog": case "block": case "map-card": return null;
  }
}
/** The roles whose line is resolved again on the body, so it takes Paper's softer lines as the members drew them. */
const BODY_LINES = ["block", "map-card"];

const PAPER_SELECTOR = /^:root(\[data-theme="dark"\])?\[data-look-panels="([\w-]+)"\]( \[data-picture-([\w-]+)\])?$/;
const PAPER_PICTURE = /^:root(\[data-theme="dark"\])? \[data-picture-panels="paper"\]$/;
const PAPER_LINES = /^:root(\[data-theme="dark"\])?\[data-look-panels="paper"\]:not\(\[data-look-contrast="more"\]\) body$/;

/** What is wrong with Paper's stylesheet; empty when it holds. */
export function paperProblems(css: string, globals: string = GLOBALS): string[] {
  const problems: string[] = [];
  const parts = roleParts(globals);
  const known = new Set([...parts].flatMap(([role, names]) => names.map(part => `--surface-${role}-${part}`)));
  const restated = new Map<string, Map<string, string>>();
  for (const rule of rules(css)) {
    if (rule.within !== null) problems.push(`${rule.within}: Paper has no conditional rule, its fills are opaque`);
    if (/!important/.test(rule.body)) problems.push(`${rule.selectors.join(", ")}: forces a declaration`);
    for (const selector of rule.selectors) {
      const pick = PAPER_SELECTOR.exec(selector), picture = PAPER_PICTURE.exec(selector), lines = PAPER_LINES.exec(selector);
      if (!pick && !picture && !lines) { problems.push(`${selector}: keyed on neither the root by Paper, its lines on the body, nor the Paper picture`); continue; }
      if (pick && (pick[2] !== "paper" || !lookChoices("panels").includes(pick[2]))) problems.push(`${selector}: ${pick[2]} is not Paper`);
      if (pick?.[4] && !OTHER_PICTURES.includes(pick[4])) problems.push(`${selector}: dresses a picture that shows its own Panels`);
      const tokens = restated.get(selector) ?? new Map<string, string>();
      for (const [property, value] of rule.declarations) {
        if (lines) {
          if (property !== "--border" && !BODY_LINES.some(role => property === `--surface-${role}-edge`)) {
            problems.push(`${selector}: sets ${property}; the body takes Paper's lines alone`);
          }
        } else if (/^--surface-(menu|dialog)-/.test(property)) {
          problems.push(`${selector}: restates ${property}; menus and dialogs are as shipped under Paper`);
        } else if (/^--surface-(block|map-card)-/.test(property)) {
          problems.push(`${selector}: restates ${property}; the blocks inside panels and the cards over the map are as shipped under Paper`);
        } else if (!known.has(property)) {
          problems.push(`${selector}: declares ${property}, not a role's part`);
        }
        tokens.set(property, value);
      }
      restated.set(selector, tokens);
    }
  }

  const holds = (selector: string, expected: Map<string, string>, under?: string) => {
    const effective = new Map([...(under ? (restated.get(under) ?? []) : []), ...(restated.get(selector) ?? [])]);
    for (const [token, value] of expected) {
      if (!effective.has(token)) problems.push(`${selector}: ${token} is not restated`);
      else if (effective.get(token) !== value) problems.push(`${selector}: ${token} is ${effective.get(token)}, not ${value}`);
    }
    for (const token of effective.keys()) if (!expected.has(token)) problems.push(`${selector}: restates ${token}, which Paper leaves as shipped`);
  };
  const wanted = (theme: Theme) => new Map(ROLE_NAMES.flatMap(role =>
    Object.entries(paper(role, theme) ?? {}).map(([part, value]) => [`--surface-${role}-${part}`, value] as [string, string])));
  const root = (dark: boolean) => `:root${dark ? '[data-theme="dark"]' : ""}[data-look-panels="paper"]`;
  const selectors = (dark: boolean) => [root(dark), ...OTHER_PICTURES.map(pick => `${root(dark)} [data-picture-${pick}]`),
    `:root${dark ? '[data-theme="dark"]' : ""} [data-picture-panels="paper"]`];
  const light = selectors(false), dark = selectors(true);
  light.forEach((selector, at) => {
    holds(selector, wanted("light"));
    holds(dark[at], wanted("dark"), selector);
  });
  const linesOn = (dark: boolean) => `${root(dark)}:not([data-look-contrast="more"]) body`;
  const bodyLines = BODY_LINES.map(role => [`--surface-${role}-edge`, "1px solid var(--border)"] as [string, string]);
  holds(linesOn(false), new Map([["--border", PAPER_LINE.light], ...bodyLines]));
  holds(linesOn(true), new Map([["--border", PAPER_LINE.dark], ...bodyLines]), linesOn(false));
  return problems;
}

describe("Liquid's stylesheet", () => {
  it("restates every part of every role in one recipe, by day and by night, on the root, the other picks' pictures and its own picture, opaque where asked", () => {
    expect(liquidProblems(LIQUID_CSS)).toEqual([]);
  });

  it("gives every role the same fill, blur, bend and rim light, in each theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const values = recipeValues(LIQUID_CSS, theme);
      expect([...values.fill], theme).toEqual([FILL[theme]]);
      expect([...values.blur], theme).toEqual([BLUR]);
      expect([...values.lens], theme).toEqual([LENS]);
      expect([...values.rim], theme).toEqual([RIM[theme]]);
    }
  });

  it("fails on a role with a blur, a fill or a bend of its own", () => {
    const blur = LIQUID_CSS.replace("  --surface-overlay-control-blur: blur(24px);\n", "  --surface-overlay-control-blur: blur(6px);\n");
    expect(blur).not.toBe(LIQUID_CSS);
    expect(liquidProblems(blur)).toContain(':root[data-look-panels="liquid"]: --surface-overlay-control-blur is blur(6px), not blur(24px)');
    expect([...recipeValues(blur, "light").blur]).toHaveLength(2);
    const fill = LIQUID_CSS.replace("  --surface-glass-chrome-fill: color-mix(in srgb, #fff 8%, var(--bg-panel) 82.8%);\n",
      "  --surface-glass-chrome-fill: color-mix(in srgb, #fff 12%, var(--bg-panel) 48.4%);\n");
    expect(fill).not.toBe(LIQUID_CSS);
    expect(liquidProblems(fill).join("\n")).toMatch(/--surface-glass-chrome-fill is color-mix\(in srgb, #fff 12%/);
    const lens = LIQUID_CSS.replace("  --surface-page-card-lens: 18;\n", "  --surface-page-card-lens: 14;\n");
    expect(lens).not.toBe(LIQUID_CSS);
    expect([...recipeValues(lens, "light").lens].sort()).toEqual(["14", "18"]);
  });

  it("fails on a rule keyed on a component's class, or on a kind of surface", () => {
    const seeded = `${LIQUID_CSS}\n.panel {\n  --surface-glass-chrome-fill: transparent;\n}\n`;
    expect(liquidProblems(seeded)).toContain(".panel: keyed on neither the root by Liquid nor the Liquid picture");
    const kind = `${LIQUID_CSS}\n:root[data-look-liquid~="chrome"] {\n  --surface-glass-chrome-fill: transparent;\n}\n`;
    expect(liquidProblems(kind)).toContain(':root[data-look-liquid~="chrome"]: keyed on neither the root by Liquid nor the Liquid picture');
  });

  it("fails on a dropped lens", () => {
    const dropped = LIQUID_CSS.replace("  --surface-glass-chrome-lens: 18;\n", "");
    expect(dropped).not.toBe(LIQUID_CSS);
    expect(liquidProblems(dropped)).toContain(':root[data-look-panels="liquid"]: --surface-glass-chrome-lens is not restated');
  });

  it("fails on a forced declaration and a part that is not a role's", () => {
    const forced = LIQUID_CSS.replace("--surface-glass-chrome-lens: 18;", "--surface-glass-chrome-lens: 18 !important;");
    expect(forced).not.toBe(LIQUID_CSS);
    expect(liquidProblems(forced).join("\n")).toMatch(/forces a declaration/);
    const own = `${LIQUID_CSS}\n:root[data-look-panels="liquid"] {\n  --liquid-tint: #fff;\n}\n`;
    expect(liquidProblems(own)).toContain(':root[data-look-panels="liquid"]: declares --liquid-tint, not a role\'s part');
  });

  it("is loaded by the document after the look's own rules", () => {
    const document = read("src/app/document.tsx");
    const look = document.indexOf('import "./look.css";'), liquidSheet = document.indexOf('import "./look-liquid.css";');
    expect(look).toBeGreaterThan(-1);
    expect(liquidSheet).toBeGreaterThan(look);
  });
});

describe("Paper's stylesheet", () => {
  it("restates every role but the menu and the dialog, by day and by night, on the root, the other picks' pictures and its own picture", () => {
    expect(paperProblems(PAPER_CSS)).toEqual([]);
  });

  it("softens the lines on the body, never on the root, and never under More contrast, the blocks' and the map cards' lines resolved there", () => {
    const lines = rules(PAPER_CSS).filter(rule => rule.declarations.some(([property]) => property === "--border"));
    expect(lines.flatMap(rule => rule.selectors)).toEqual([
      ':root[data-look-panels="paper"]:not([data-look-contrast="more"]) body',
      ':root[data-theme="dark"][data-look-panels="paper"]:not([data-look-contrast="more"]) body',
    ]);
  });

  it("fails on a menu's part restated, and on a rule keyed on a component's class", () => {
    const menu = PAPER_CSS.replace("  --surface-glass-chrome-blur: none;\n", "  --surface-glass-chrome-blur: none;\n  --surface-menu-fill: var(--bg-raised);\n");
    expect(menu).not.toBe(PAPER_CSS);
    expect(paperProblems(menu)).toContain(':root[data-look-panels="paper"]: restates --surface-menu-fill; menus and dialogs are as shipped under Paper');
    const dialog = `${PAPER_CSS}\n:root[data-look-panels="paper"] {\n  --surface-dialog-edge: none;\n}\n`;
    expect(paperProblems(dialog)).toContain(':root[data-look-panels="paper"]: restates --surface-dialog-edge; menus and dialogs are as shipped under Paper');
    const seeded = `${PAPER_CSS}\n.card {\n  --surface-page-card-fill: var(--bg-raised);\n}\n`;
    expect(paperProblems(seeded)).toContain(".card: keyed on neither the root by Paper, its lines on the body, nor the Paper picture");
  });

  it("fails on a block's line left on the root, where Paper's softer line would not reach it", () => {
    const left = PAPER_CSS.replace("  --surface-block-edge: 1px solid var(--border);\n", "");
    expect(left).not.toBe(PAPER_CSS);
    expect(paperProblems(left)).toContain(':root[data-look-panels="paper"]:not([data-look-contrast="more"]) body: --surface-block-edge is not restated');
  });

  it("fails on lines that reach More contrast, and on a part dropped", () => {
    const always = PAPER_CSS.replaceAll(':not([data-look-contrast="more"]) body', " body");
    expect(always).not.toBe(PAPER_CSS);
    expect(paperProblems(always).join("\n")).toMatch(/:root\[data-look-panels="paper"\] body: keyed on neither/);
    const dropped = PAPER_CSS.replace("  --surface-glass-chrome-blur: none;\n", "");
    expect(paperProblems(dropped)).toContain(':root[data-look-panels="paper"]: --surface-glass-chrome-blur is not restated');
  });

  it("is loaded by the document after the look's own rules", () => {
    const document = read("src/app/document.tsx");
    expect(document.indexOf('import "./look-paper.css";')).toBeGreaterThan(document.indexOf('import "./look.css";'));
    expect(document.indexOf('import "./look.css";')).toBeGreaterThan(-1);
  });
});
