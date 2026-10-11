import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIQUID_KINDS, lookChoices } from "@/lib/look";

/**
 * The Panels looks' stylesheets. A look restates the surface roles' parts
 * and nothing else: keyed on the workspace root by the look's pick or a
 * kind's word, on the pictures of the other picks (which show the
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

const ROLE_NAMES = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "page-card", "inner-card", "menu", "dialog", "stage"] as const;
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
const FILL_PARTS = new Set(["fill", "knob", "mark", "fill-raised"]);

/** The roles each kind is, by its word on the root. */
const KIND_ROLES: Record<string, Role[]> = {
  chrome: ["glass-chrome"],
  panels: ["glass-panel"],
  map: ["overlay-panel", "stage"],
  buttons: ["overlay-control"],
  cards: ["page-card"],
  inner: ["inner-card"],
  menus: ["menu"],
  dialogs: ["dialog"],
};

/* ---- Liquid's values ---- */

/** The light on the rim, drawn inside the edge: the sides facing the light
 * (the upper left), the far side fainter, a faint glow. */
const RIM: Record<Theme, string> = {
  light: "inset 1px 1px 0 rgba(255, 255, 255, 0.9), inset -1px -1px 0 rgba(255, 255, 255, 0.405), inset 0 0 14px rgba(255, 255, 255, 0.144)",
  dark: "inset 1px 1px 0 rgba(255, 255, 255, 0.42), inset -1px -1px 0 rgba(255, 255, 255, 0.168), inset 0 0 14px rgba(255, 255, 255, 0.067)",
};
/** The soft two-layer drops. */
const DROP: Record<Theme, Record<"lift" | "button" | "card" | "inner" | "dialog", string>> = {
  light: {
    lift: "0 1px 1px color-mix(in srgb, var(--shadow) 20%, transparent), 0 12px 32px -6px color-mix(in srgb, var(--shadow) 85%, transparent)",
    button: "0 1px 1px color-mix(in srgb, var(--shadow) 20%, transparent), 0 6px 18px -4px color-mix(in srgb, var(--shadow) 80%, transparent)",
    card: "0 1px 2px color-mix(in srgb, var(--shadow) 30%, transparent), 0 8px 24px -6px color-mix(in srgb, var(--shadow) 60%, transparent)",
    inner: "0 1px 2px color-mix(in srgb, var(--shadow) 40%, transparent), 0 4px 12px -4px color-mix(in srgb, var(--shadow) 50%, transparent)",
    dialog: "0 1px 1px color-mix(in srgb, var(--shadow) 20%, transparent), 0 24px 64px -12px var(--shadow)",
  },
  dark: {
    lift: "0 1px 1px rgba(0, 0, 0, 0.35), 0 14px 36px -6px rgba(0, 0, 0, 0.55)",
    button: "0 1px 1px rgba(0, 0, 0, 0.35), 0 6px 18px -4px rgba(0, 0, 0, 0.5)",
    card: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px -6px rgba(0, 0, 0, 0.45)",
    inner: "0 1px 2px rgba(0, 0, 0, 0.45), 0 4px 12px -4px rgba(0, 0, 0, 0.4)",
    dialog: "0 1px 1px rgba(0, 0, 0, 0.4), 0 24px 64px -12px rgba(0, 0, 0, 0.7)",
  },
};
/** The fills: the panel tone under a tint at a share, as one colour (by
 * day white 0.12 over 55 %, 0.08 over 90 %, 0.10 over 70 %, 0.10 over
 * 55 %, 0.08 over 92 %; by night black 0.06 over 55 %, 0.08 over 78 %,
 * 0.06 over 66 %, white 0.04 over the hover tone at 55 %, black 0.08 over
 * 80 %), and the same tints over a full share when a fill goes opaque. */
type FillKind = "glass" | "read" | "card" | "inner" | "dialog";
const FILL: Record<Theme, Record<FillKind, string>> = {
  light: {
    glass: "color-mix(in srgb, #fff 12%, var(--bg-panel) 48.4%)",
    read: "color-mix(in srgb, #fff 8%, var(--bg-panel) 82.8%)",
    card: "color-mix(in srgb, #fff 10%, var(--bg-panel) 63%)",
    inner: "color-mix(in srgb, #fff 10%, var(--bg-panel) 49.5%)",
    dialog: "color-mix(in srgb, #fff 8%, var(--bg-panel) 84.64%)",
  },
  dark: {
    glass: "color-mix(in srgb, #000 6%, var(--bg-panel) 51.7%)",
    read: "color-mix(in srgb, #000 8%, var(--bg-panel) 71.76%)",
    card: "color-mix(in srgb, #000 6%, var(--bg-panel) 62.04%)",
    inner: "color-mix(in srgb, #fff 4%, var(--bg-hover) 52.8%)",
    dialog: "color-mix(in srgb, #000 8%, var(--bg-panel) 73.6%)",
  },
};
const OPAQUE: Record<Theme, Record<FillKind, string>> = {
  light: {
    glass: "color-mix(in srgb, #fff 12%, var(--bg-panel) 88%)",
    read: "color-mix(in srgb, #fff 8%, var(--bg-panel) 92%)",
    card: "color-mix(in srgb, #fff 10%, var(--bg-panel) 90%)",
    inner: "color-mix(in srgb, #fff 10%, var(--bg-panel) 90%)",
    dialog: "color-mix(in srgb, #fff 8%, var(--bg-panel) 92%)",
  },
  dark: {
    glass: "color-mix(in srgb, #000 6%, var(--bg-panel) 94%)",
    read: "color-mix(in srgb, #000 8%, var(--bg-panel) 92%)",
    card: "color-mix(in srgb, #000 6%, var(--bg-panel) 94%)",
    inner: "color-mix(in srgb, #fff 4%, var(--bg-hover) 96%)",
    dialog: "color-mix(in srgb, #000 8%, var(--bg-panel) 92%)",
  },
};
const CLEAR = "1px solid transparent";

/** Each role's parts under Liquid, with the fills it goes opaque at. */
function liquid(role: Role, theme: Theme, fills: Record<Theme, Record<FillKind, string>> = FILL): Record<string, string> {
  const lit = (drop: keyof (typeof DROP)[Theme]) => `${RIM[theme]}, ${DROP[theme][drop]}`;
  const fill = fills[theme];
  switch (role) {
    case "glass-chrome": return { fill: fill.glass, blur: "blur(9px)", edge: "none", shadow: lit("lift"), lens: "20" };
    case "glass-panel": return { fill: fill.read, blur: "blur(24px)", edge: "none", shadow: lit("lift"), lens: "18" };
    case "overlay-panel": return { fill: fill.read, blur: "blur(24px)", edge: "none", shadow: lit("lift"), lens: "18" };
    case "overlay-control": return { fill: fill.glass, blur: "blur(6px)", edge: "none", shadow: lit("button"), lens: "12", grow: "none" };
    case "page-card": return { fill: fill.card, blur: "blur(14px)", edge: CLEAR, shadow: lit("card"), "shadow-hover": lit("lift"), lens: "14" };
    case "inner-card": return {
      fill: fill.inner, blur: "blur(6px)", edge: CLEAR, shadow: lit("inner"), "shadow-lifted": lit("lift"), "shadow-dragged": lit("lift"),
      lens: "8", knob: fill.inner, mark: fill.inner,
    };
    case "menu": return { fill: fill.read, blur: "blur(24px)", edge: CLEAR, shadow: lit("lift"), lens: "14", "edge-strong": CLEAR, "fill-raised": fill.read };
    case "dialog": return { fill: fill.dialog, blur: "blur(24px)", edge: CLEAR, shadow: lit("dialog"), lens: "18" };
    case "stage": return { fill: "transparent", blur: "none", edge: "none", shadow: DROP[theme].lift };
  }
}

const SUPPORTS = "@supports not (backdrop-filter: blur(1px))";
const REQUEST = "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)";
/** The pictures of the other picks: they show the person's look. */
const OTHER_PICTURES = ["color", "contrast", "corners"];

const KIND_SELECTOR = /^:root(\[data-theme="dark"\])?\[data-look-liquid~="([\w-]+)"\]( \[data-picture-([\w-]+)\])?$/;
const PICTURE_SELECTOR = /^:root(\[data-theme="dark"\])? \[data-picture-panels="liquid"\]$/;

/** What is wrong with Liquid's stylesheet; empty when it holds. */
export function liquidProblems(css: string, globals: string = GLOBALS): string[] {
  const problems: string[] = [];
  const parts = roleParts(globals);
  const words = LIQUID_KINDS.map(([, word]) => word as string);
  const known = new Set([...parts].flatMap(([role, names]) => names.map(part => `--surface-${role}-${part}`)));

  // Each selector's restated parts, per condition, in source order.
  const restated = new Map<string, Map<string, string>>();
  for (const rule of rules(css)) {
    if (rule.within !== null && rule.within !== SUPPORTS && rule.within !== REQUEST) problems.push(`${rule.within}: not a condition a look keys on`);
    if (/!important/.test(rule.body)) problems.push(`${rule.selectors.join(", ")}: forces a declaration`);
    for (const selector of rule.selectors) {
      const kind = KIND_SELECTOR.exec(selector), picture = PICTURE_SELECTOR.exec(selector);
      if (!kind && !picture) { problems.push(`${selector}: keyed on neither the root by a kind's word nor the Liquid picture`); continue; }
      if (kind && !words.includes(kind[2])) problems.push(`${selector}: ${kind[2]} is not a kind's word`);
      if (kind?.[4] && !OTHER_PICTURES.includes(kind[4])) problems.push(`${selector}: dresses a picture that shows its own Panels`);
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
      if (!expected.has(token)) problems.push(`${selector}${within ? ` within ${within}` : ""}: restates ${token}, which is not its kind's`);
    }
  };
  const wanted = (roles: Role[], theme: Theme, opaque: boolean) => new Map(roles.flatMap(role => {
    const values = liquid(role, theme, opaque ? OPAQUE : FILL);
    // The stage has no ground of its own to make opaque.
    return parts.get(role)!.filter(part => restates(part) && (!opaque || (FILL_PARTS.has(part) && role !== "stage")))
      .map(part => [`--surface-${role}-${part}`, values[part] ?? "(no value named)"] as [string, string]);
  }));

  const targets: { roles: Role[]; light: string[]; dark: string[] }[] = [
    ...words.map(word => {
      const root = (dark: boolean) => `:root${dark ? '[data-theme="dark"]' : ""}[data-look-liquid~="${word}"]`;
      return {
        roles: KIND_ROLES[word] ?? [],
        light: [root(false), ...OTHER_PICTURES.map(pick => `${root(false)} [data-picture-${pick}]`)],
        dark: [root(true), ...OTHER_PICTURES.map(pick => `${root(true)} [data-picture-${pick}]`)],
      };
    }),
    { roles: [...ROLE_NAMES], light: [':root [data-picture-panels="liquid"]'], dark: [':root[data-theme="dark"] [data-picture-panels="liquid"]'] },
  ];
  for (const { roles, light, dark } of targets) {
    light.forEach((selector, at) => {
      holds(null, selector, wanted(roles, "light", false));
      holds(null, dark[at], wanted(roles, "dark", false), selector);
      for (const condition of [SUPPORTS, REQUEST]) {
        holds(condition, selector, wanted(roles, "light", true));
        holds(condition, dark[at], wanted(roles, "dark", true));
      }
    });
  }
  return problems;
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

/** Each role's parts under Paper; menus and dialogs are as shipped. */
function paper(role: Role, theme: Theme): Record<string, string> | null {
  const sheet = { fill: PAPER_PANEL[theme], blur: "none", edge: "none", shadow: PAPER_LIFT[theme].lift };
  switch (role) {
    case "glass-chrome": case "glass-panel": case "overlay-panel": case "overlay-control": return sheet;
    case "page-card": return { fill: PAPER_PANEL[theme], blur: "none", edge: CLEAR, shadow: PAPER_LIFT[theme].card, "shadow-hover": PAPER_LIFT[theme].lift };
    case "inner-card": return {
      fill: theme === "light" ? "var(--bg-panel)" : "var(--bg-hover)", blur: "none", edge: CLEAR, shadow: PAPER_LIFT[theme].inner,
      "shadow-lifted": PAPER_LIFT[theme].card, "shadow-dragged": PAPER_LIFT[theme].lift,
    };
    case "stage": return { shadow: PAPER_LIFT[theme].lift };
    case "menu": case "dialog": return null;
  }
}

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
          if (property !== "--border") problems.push(`${selector}: sets ${property}; the body takes Paper's lines alone`);
        } else if (/^--surface-(menu|dialog)-/.test(property)) {
          problems.push(`${selector}: restates ${property}; menus and dialogs are as shipped under Paper`);
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
  holds(linesOn(false), new Map([["--border", PAPER_LINE.light]]));
  holds(linesOn(true), new Map([["--border", PAPER_LINE.dark]]), linesOn(false));
  return problems;
}

describe("Liquid's stylesheet", () => {
  it("restates every part of each kind's roles, by day and by night, on the root, the other picks' pictures and its own picture, opaque where asked", () => {
    expect(liquidProblems(LIQUID_CSS)).toEqual([]);
  });

  it("covers every kind the catalogue offers, each with its roles", () => {
    expect(LIQUID_KINDS.map(([, word]) => word)).toEqual(Object.keys(KIND_ROLES));
    expect(new Set(Object.values(KIND_ROLES).flat())).toEqual(new Set(ROLE_NAMES));
  });

  it("fails on a rule keyed on a component's class", () => {
    const seeded = `${LIQUID_CSS}\n.panel {\n  --surface-glass-chrome-fill: transparent;\n}\n`;
    expect(liquidProblems(seeded)).toContain(".panel: keyed on neither the root by a kind's word nor the Liquid picture");
  });

  it("fails on a dropped lens", () => {
    const dropped = LIQUID_CSS.replace("  --surface-glass-chrome-lens: 20;\n", "");
    expect(dropped).not.toBe(LIQUID_CSS);
    expect(liquidProblems(dropped)).toContain(':root[data-look-liquid~="chrome"]: --surface-glass-chrome-lens is not restated');
  });

  it("fails on a forced declaration, a part that is not a role's, and a kind's word the catalogue does not offer", () => {
    const forced = LIQUID_CSS.replace("--surface-glass-chrome-lens: 20;", "--surface-glass-chrome-lens: 20 !important;");
    expect(forced).not.toBe(LIQUID_CSS);
    expect(liquidProblems(forced).join("\n")).toMatch(/forces a declaration/);
    const own = `${LIQUID_CSS}\n:root[data-look-liquid~="chrome"] {\n  --liquid-tint: #fff;\n}\n`;
    expect(liquidProblems(own)).toContain(':root[data-look-liquid~="chrome"]: declares --liquid-tint, not a role\'s part');
    const unknown = `${LIQUID_CSS}\n:root[data-look-liquid~="all"] {\n  --surface-menu-lens: 14;\n}\n`;
    expect(liquidProblems(unknown)).toContain(':root[data-look-liquid~="all"]: all is not a kind\'s word');
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

  it("softens the lines on the body, never on the root, and never under More contrast", () => {
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
