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
 * the theme supplies the tones. */
const ROLES: Record<string, Record<string, string>> = {
  "glass-chrome": { fill: FILLS.glass, blur: STRENGTHS.glass, edge: "none", shadow: STEPS.float },
  "glass-panel": { fill: FILLS.glass, blur: STRENGTHS.glass, edge: "none", shadow: STEPS.float, corner: "var(--radius-card)" },
  "overlay-panel": { fill: FILLS.glass, blur: STRENGTHS.overlay, edge: "none", shadow: STEPS.overlay },
  "overlay-control": { fill: FILLS.glass, blur: STRENGTHS.overlay, edge: "none", shadow: STEPS.float },
  "page-card": {
    fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.float, "shadow-hover": STEPS.deep,
    corner: "var(--radius-card)",
  },
  "inner-card": {
    fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.hairline,
    "shadow-lifted": STEPS.float, "shadow-dragged": STEPS.deep,
  },
  menu: { fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.lift },
  dialog: { fill: "var(--bg-panel)", blur: "none", edge: HAIRLINE, shadow: STEPS.dialog, corner: "var(--radius-card)" },
  stage: { fill: "transparent", blur: "none", edge: "none", shadow: STEPS.deep, corner: "var(--radius-card)" },
};

const VOCABULARY = /^--(shadow-[\w-]+|blur-[\w-]+|fill-[\w-]+|edge-[\w-]+|surface-[\w-]+)$/;
/** The stylesheets that set tones: the shipped tokens, the look, the pictures. */
const TOKEN_SHEETS = ["src/app/globals.css", "src/app/look.css", "src/components/settings/look-pictures.css"];

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

/** The element a selector styles: the root, or its last compound. */
const target = (selector: string) => {
  const last = selector.split(/\s*[\s>+~]\s*/).filter(Boolean).pop() ?? selector;
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
        if (!covered(element)) problems.push(`${file}: ${selector} restates ${tones.join(", ")} on ${element}, outside the block's scopes`);
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
  it("is one block of six steps, three strengths, three fills and nine roles at their named values, on every element that restates a tone it reads", () => {
    expect(vocabularyProblems(SHEETS)).toEqual([]);
  });

  it("names the root, a published page's dark root, an image's default scope and the pictures among its scopes", () => {
    const block = rules(SHEETS["src/app/globals.css"]).find(rule => rule.tokens.has("--surface-menu-shadow"))!;
    expect(block.selectors).toEqual(expect.arrayContaining([
      ":root", '[data-view-theme="dark"]', "[data-look-default]", "[data-picture-color]", "[data-picture-contrast]", "[data-picture-corners]",
    ]));
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

  it("is declared by no other stylesheet: a surface reads its role and never makes its own", () => {
    const own = stylesheets("src").filter(file => file !== "src/app/globals.css").flatMap(file =>
      rules(read(file)).flatMap(rule => [...rule.tokens.keys()].filter(token => VOCABULARY.test(token)).map(token => `${file} ${rule.selectors.join(", ")} ${token}`)));
    expect(own).toEqual([]);
  });
});
