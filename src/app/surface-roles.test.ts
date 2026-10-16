import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The surface vocabulary: the shadow steps, the blur strengths, the
 * translucent fills and the roles that read them, declared once in the
 * shipped tokens. Held here as the browser would resolve it: one block,
 * on every element that restates a tone the roles read (a custom
 * property's references resolve where it is declared, so a role declared
 * on the root alone would carry the root's tones into a published page's
 * dark mode and into an image), each role carrying its parts at the
 * values the design names. The values are written out below as literals,
 * never read back from the stylesheet they judge.
 */

const STEPS: Record<string, string> = {
  hairline: "0 1px 4px color-mix(in srgb, var(--shadow) 60%, transparent)",
  float: "0 3px 12px var(--shadow)",
  overlay: "0 8px 26px var(--shadow)",
  lift: "0 10px 30px var(--shadow)",
  deep: "0 14px 40px var(--shadow)",
  dialog: "0 30px 80px var(--shadow)",
};
const STRENGTHS: Record<string, string> = { glass: "blur(18px)", overlay: "blur(8px)", veil: "blur(4px)" };
const FILLS: Record<string, string> = {
  glass: "color-mix(in srgb, var(--bg-panel) 93%, transparent)",
  wash: "color-mix(in srgb, var(--bg-raised) 70%, transparent)",
  veil: "color-mix(in srgb, var(--fg) 32%, transparent)",
};
const HAIRLINE = "1px solid var(--border)";

/** Each role's parts at the values the design names, both themes alike:
 * the theme supplies the tones. Every role but the stage has a lens, how
 * far its edge pulls the backdrop in, none in the shipped look; the
 * overlay control's growth on hover, a page card's stronger line under the
 * pointer, the menu's stronger edge and raised ground, and the inner
 * card's bright knob, accent mark, stronger line under the pointer and the
 * dashed line of a card that makes something new are today's values, so a
 * look can restate them. A block inside a panel and a card over the map are
 * the solid surfaces they drew before they read a role: the raised or the
 * panel tone, the hairline, no shadow, and no blur or lens for the block,
 * which lies on its panel. */
const ROLES: Record<string, Record<string, string>> = {
  "glass-chrome": { fill: FILLS.glass, blur: STRENGTHS.glass, edge: "none", shadow: STEPS.float, lens: "0" },
  "glass-panel": { fill: FILLS.glass, blur: STRENGTHS.glass, edge: "none", shadow: STEPS.float, corner: "var(--radius-card)", lens: "0" },
  "overlay-panel": { fill: FILLS.glass, blur: STRENGTHS.overlay, edge: "none", shadow: STEPS.overlay, lens: "0" },
  "overlay-control": { fill: FILLS.glass, blur: STRENGTHS.overlay, edge: "none", shadow: STEPS.float, lens: "0", grow: "scale(1.06)" },
  "page-card": {
    fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.float, "shadow-hover": STEPS.deep,
    "edge-hover": "1px solid var(--border-strong)", corner: "var(--radius-card)", lens: "0",
  },
  "inner-card": {
    fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.hairline,
    "shadow-lifted": STEPS.float, "shadow-dragged": STEPS.deep, lens: "0", knob: "#fff", mark: "var(--accent)",
    "edge-hover": "1px solid var(--border-strong)", "edge-new": "1px dashed var(--border-strong)",
  },
  menu: {
    fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.lift, lens: "0", "edge-strong": "1px solid var(--border-strong)",
    "fill-raised": "var(--bg-raised)",
  },
  dialog: { fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.dialog, corner: "var(--radius-card)", lens: "0" },
  block: { fill: "var(--bg-raised)", "fill-panel": "var(--bg-panel)", edge: HAIRLINE, shadow: "none" },
  "map-card": { fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: "none", lens: "0" },
  stage: { fill: "transparent", blur: "none", edge: "none", shadow: STEPS.deep, corner: "var(--radius-card)" },
};

const VOCABULARY = /^--(shadow-[\w-]+|blur-[\w-]+|fill-[\w-]+|edge-[\w-]+|surface-[\w-]+)$/;
/** The stylesheets that set tones or restate roles: the shipped tokens, the
 * look, the pictures, the Panels looks. */
const TOKEN_SHEETS = ["src/app/globals.css", "src/app/look.css", "src/components/settings/look-pictures.css", "src/app/look-liquid.css",
  "src/app/look-paper.css"];
/** A tone restated off the block's scopes on purpose, with its reason. */
const TONES_OFF_SCOPE: { file: string; element: string; why: string }[] = [
  { file: "src/app/look-paper.css", element: "body", why: "Paper's quieter lines: the roles keep the root's line, so a menu's and a dialog's edge stay as shipped" },
];
/** A role's part restated off the block's scopes on purpose, with its reason. */
const PARTS_OFF_SCOPE: { file: string; element: string; parts: string[]; why: string }[] = [
  {
    file: "src/app/look-paper.css", element: "body", parts: ["--surface-block-edge", "--surface-map-card-edge"],
    why: "a block's and a map card's line resolved again where Paper softens the lines, so they keep the softer line they drew",
  },
];
/** The look's stylesheets: they restate a role's parts and the fills for a
 * look, and declare nothing else of the vocabulary. */
const RESTATERS = ["src/app/look.css", "src/app/look-liquid.css", "src/app/look-paper.css"];
const RESTATED = /^--(surface-[\w-]+|fill-[\w-]+)$/;

type Rule = { selectors: string[]; tokens: Map<string, string> };

/** Every flat rule of a stylesheet, comments removed, its custom properties in order. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean),
    tokens: new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim().replace(/\s+/g, " ")])),
  }));
}

/** A token's value with every reference to another token of the same rule
 * written out, so a role reads as the literal it computes to; references
 * outside the rule (the theme's tones) stay as they are. */
function resolve(tokens: Map<string, string>, token: string, depth = 0): string {
  const value = tokens.get(token);
  if (value === undefined) throw new Error(`${token} is not declared`);
  if (depth > 6) throw new Error(`${token} refers too deep`);
  return value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => (tokens.has(name) ? resolve(tokens, name, depth + 1) : whole));
}

/** The element a selector styles: the root, or its last compound (a `~=`
 * inside an attribute is a match, not a combinator). */
const target = (selector: string) => {
  const last = selector.split(/\s*(?:[\s>+]|~(?!=))\s*/).filter(Boolean).pop() ?? selector;
  return last.startsWith(":root") ? ":root" : last;
};

/** What is wrong with the vocabulary in these stylesheets; empty when it holds. */
export function vocabularyProblems(sheets: Record<string, string>): string[] {
  const problems: string[] = [];
  const globals = sheets["src/app/globals.css"];
  const blocks = rules(globals).filter(rule => [...rule.tokens.keys()].some(token => VOCABULARY.test(token)));
  if (!blocks.length) return ["no block declares the vocabulary"];
  if (blocks.length > 1) problems.push(`expected one block declaring the vocabulary, found ${blocks.length}`);
  const [block] = blocks;

  // Only vocabulary in the block: a tone set here would shadow the theme's.
  for (const token of block.tokens.keys()) if (!VOCABULARY.test(token)) problems.push(`the block sets ${token}, which is not vocabulary`);

  // Each step, strength and fill declared once in the whole file, at its value.
  const counts = (name: string) => [...globals.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(new RegExp(`(^|[;{\\s])${name}\\s*:`, "g"))].length;
  const families: [string, Record<string, string>][] = [["--shadow-", STEPS], ["--blur-", STRENGTHS], ["--fill-", FILLS]];
  for (const [prefix, values] of families) {
    for (const [name, value] of Object.entries(values)) {
      const token = prefix + name;
      if (counts(token) !== 1) problems.push(`${token} is declared ${counts(token)} times`);
      else if (block.tokens.get(token) !== value) problems.push(`${token} is ${block.tokens.get(token)}, not ${value}`);
    }
    const extra = [...block.tokens.keys()].filter(token => token.startsWith(prefix) && !(token.slice(prefix.length) in values));
    for (const token of extra) problems.push(`${token} is not one of the named values`);
  }

  // Each role carries exactly its parts, each reading the vocabulary or a tone.
  for (const [role, parts] of Object.entries(ROLES)) {
    for (const [part, value] of Object.entries(parts)) {
      const token = `--surface-${role}-${part}`;
      if (!block.tokens.has(token)) { problems.push(`${token} is missing`); continue; }
      const resolved = resolve(block.tokens, token);
      if (resolved !== value) problems.push(`${token} computes ${resolved}, not ${value}`);
      if (/\d+px \d+px/.test(block.tokens.get(token)!)) problems.push(`${token} types a shadow instead of reading a step`);
    }
  }
  const known = new Set(Object.entries(ROLES).flatMap(([role, parts]) => Object.keys(parts).map(part => `--surface-${role}-${part}`)));
  for (const token of block.tokens.keys()) if (token.startsWith("--surface-") && !known.has(token)) problems.push(`${token} is not a role's part`);

  // The block is declared on every element that restates a tone it reads.
  const read = new Set([...block.tokens.values()].flatMap(value => [...value.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]))
    .filter(token => !block.tokens.has(token)));
  const scopes = new Set(block.selectors);
  const covered = (element: string) => {
    if (scopes.has(element)) return true;
    const attribute = /^\[([\w-]+)(?:[~|^$*]?=.*)?\]$/.exec(element);
    return Boolean(attribute && scopes.has(`[${attribute[1]}]`));
  };
  for (const [file, css] of Object.entries(sheets)) {
    for (const rule of rules(css)) {
      if (rule === block) continue;
      const tones = [...rule.tokens.keys()].filter(token => read.has(token));
      if (!tones.length) continue;
      for (const selector of rule.selectors) {
        const element = target(selector);
        if (TONES_OFF_SCOPE.some(entry => entry.file === file && entry.element === element)) continue;
        if (!covered(element)) problems.push(`${file}: ${selector} restates ${tones.join(", ")} on ${element}, outside the block's scopes`);
      }
    }
  }

  // A role restated anywhere but the root (a look's picture) is restated on
  // an element the block is declared on, so every other picture of the
  // same pick keeps the shipped roles whatever the root's look.
  for (const [file, css] of Object.entries(sheets)) {
    for (const rule of rules(css)) {
      if (rule === block) continue;
      const parts = [...rule.tokens.keys()].filter(token => token.startsWith("--surface-"));
      if (!parts.length) continue;
      for (const selector of rule.selectors) {
        const element = target(selector);
        const named = PARTS_OFF_SCOPE.find(entry => entry.file === file && entry.element === element);
        const off = parts.filter(part => !named?.parts.includes(part));
        if (off.length && !covered(element)) problems.push(`${file}: ${selector} restates ${off.join(", ")} on ${element}, outside the block's scopes`);
      }
    }
  }
  return problems;
}

const read = (file: string) => readFileSync(file, "utf8");
const SHEETS = Object.fromEntries(TOKEN_SHEETS.map(file => [file, read(file)]));

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) return stylesheets(file);
    return file.endsWith(".css") ? [file.split(path.sep).join("/")] : [];
  });
}

describe("the surface vocabulary", () => {
  it("is one block of six steps, three strengths, three fills and eleven roles at their named values, on every element that restates a tone it reads", () => {
    expect(vocabularyProblems(SHEETS)).toEqual([]);
  });

  it("names the root, a published page's dark root, an image's default scope and the pictures among its scopes", () => {
    const block = rules(SHEETS["src/app/globals.css"]).find(rule => rule.tokens.has("--surface-menu-shadow"))!;
    expect(block.selectors).toEqual(expect.arrayContaining([
      ":root", '[data-view-theme="dark"]', "[data-look-default]", "[data-picture-color]", "[data-picture-contrast]", "[data-picture-corners]",
      "[data-picture-panels]",
    ]));
  });

  it("fails when the Panels pictures' scope is dropped while a look restates a role on its picture", () => {
    // A look's picture restates the roles on the picture itself; the block
    // declared there is what keeps the other pictures of Panels on the shipped roles.
    const picture = ':root [data-picture-panels="liquid"] {\n  --surface-glass-chrome-blur: blur(9px);\n}\n';
    const seeded = { ...SHEETS, "src/app/look-liquid.css": picture };
    expect(vocabularyProblems(seeded)).toEqual([]);
    const globals = SHEETS["src/app/globals.css"];
    expect(globals).toContain("[data-picture-panels] {");
    const dropped = globals.replace(",\n[data-picture-panels] {", " {");
    expect(dropped).not.toBe(globals);
    expect(vocabularyProblems({ ...seeded, "src/app/globals.css": dropped }))
      .toContain('src/app/look-liquid.css: :root [data-picture-panels="liquid"] restates --surface-glass-chrome-blur on [data-picture-panels="liquid"], outside the block\'s scopes');
  });

  it("fails when a scope that restates tones is dropped from the block: an image's, then a published page's dark root", () => {
    const without = (scope: string) => ({ ...SHEETS, "src/app/globals.css": SHEETS["src/app/globals.css"].replace(`${scope},\n`, "") });
    expect(SHEETS["src/app/globals.css"]).toContain("[data-look-default],\n");
    expect(vocabularyProblems(without("[data-look-default]")).join("\n")).toMatch(/\[data-look-default\] restates .*--bg-panel.* outside the block's scopes/);
    expect(SHEETS["src/app/globals.css"]).toContain('[data-view-theme="dark"],\n');
    expect(vocabularyProblems(without('[data-view-theme="dark"]')).join("\n")).toMatch(/\[data-view-theme="dark"\] restates .*--shadow.* outside the block's scopes/);
  });

  it("fails on a role that types its value, a step at another value and a second declaration of a step", () => {
    const globals = SHEETS["src/app/globals.css"];
    const typed = globals.replace("--surface-menu-shadow: var(--shadow-lift);", "--surface-menu-shadow: 0 10px 30px var(--shadow);");
    expect(typed).not.toBe(globals);
    expect(vocabularyProblems({ ...SHEETS, "src/app/globals.css": typed })).toContain("--surface-menu-shadow types a shadow instead of reading a step");
    const moved = globals.replace("--shadow-float: 0 3px 12px var(--shadow);", "--shadow-float: 0 3px 14px var(--shadow);");
    expect(vocabularyProblems({ ...SHEETS, "src/app/globals.css": moved }).join("\n")).toMatch(/--shadow-float is 0 3px 14px/);
    const twice = globals + "\n.x { --shadow-float: 0 3px 12px var(--shadow); }\n";
    expect(vocabularyProblems({ ...SHEETS, "src/app/globals.css": twice })).toContain("--shadow-float is declared 2 times");
  });

  it("is declared by no other stylesheet: a surface reads its role and never makes its own; a look only restates roles and fills", () => {
    const own = stylesheets("src").filter(file => file !== "src/app/globals.css").flatMap(file =>
      rules(read(file)).flatMap(rule => [...rule.tokens.keys()]
        .filter(token => VOCABULARY.test(token) && !(RESTATERS.includes(file) && RESTATED.test(token)))
        .map(token => `${file} ${rule.selectors.join(", ")} ${token}`)));
    expect(own).toEqual([]);
  });
});
