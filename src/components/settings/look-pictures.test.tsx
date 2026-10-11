import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOOK_KEYS, lookChoices, type LookKey } from "@/lib/look";
import { LookPicture } from "./LookPictures";
import { PICTURE_PICKS } from "./look-tab";

/**
 * The Appearance tab's pictures. Each shows its own option while the rest
 * of it follows the person's look, so a picture of a pick must carry
 * exactly the tokens the whole page would carry with that pick made, for
 * every look the person can have. Held here by reading three stylesheets
 * as the browser resolves them: the root's (the shipped tokens and the
 * look), and the pictures' own, keyed on the same root and on the
 * picture's option. How the pictures look is judged by eye against the
 * approved drawings.
 */

type Rule = { root: Record<string, string>; picture: [key: string, value: string | null] | null; specificity: number; order: number; tokens: Map<string, string> };

function parse(css: string, offset: number): Rule[] {
  const out: Rule[] = [];
  let order = offset;
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = new Map<string, string>();
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    order += 1;
    for (const raw of match[1].split(",")) {
      const selector = raw.trim().replace(/\s+/g, " ");
      const shape = /^:root((?:\[[\w-]+="[^"]*"\])*)(?: \[data-picture-([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
      if (!shape) continue;
      const root = Object.fromEntries([...shape[1].matchAll(/\[([\w-]+)="([^"]*)"\]/g)].map(([, name, value]) => [name, value]));
      const picture: Rule["picture"] = shape[2] ? [shape[2], shape[3] ?? null] : null;
      out.push({ root, picture, specificity: 1 + Object.keys(root).length + (picture ? 1 : 0), order, tokens });
    }
  }
  return out;
}

const ROOT_RULES = [...parse(readFileSync("src/app/globals.css", "utf8"), 0), ...parse(readFileSync("src/app/look.css", "utf8"), 100_000)]
  .filter(rule => rule.picture === null);
const PICTURE_SHEET = readFileSync("src/components/settings/look-pictures.css", "utf8");
const PICTURE_RULES = parse(PICTURE_SHEET, 0).filter(rule => rule.picture !== null);

const onRoot = (rule: Rule, root: Record<string, string>) => Object.entries(rule.root).every(([name, value]) => root[name] === value);

/** The winning value among rules, with every value tied at the top. */
function winner(candidates: Rule[], token: string) {
  if (!candidates.length) return null;
  const top = Math.max(...candidates.map(rule => rule.specificity));
  const tied = candidates.filter(rule => rule.specificity === top);
  return { value: tied.reduce((a, b) => (b.order > a.order ? b : a)).tokens.get(token)!, tied: new Set(tied.map(rule => rule.tokens.get(token))) };
}

/** A token on the document root. */
const onTheRoot = (token: string, root: Record<string, string>) =>
  winner(ROOT_RULES.filter(rule => rule.tokens.has(token) && onRoot(rule, root)), token)!.value;

/** A token on a picture of `key` = `value` under that root: its own rules, else what it inherits. */
function onThePicture(token: string, root: Record<string, string>, key: string, value: string) {
  const own = winner(PICTURE_RULES.filter(rule => rule.tokens.has(token) && onRoot(rule, root)
    && rule.picture![0] === key && (rule.picture![1] === null || rule.picture![1] === value)), token);
  return own ?? { value: token === "--picture-sheet" ? undefined : onTheRoot(token, root), tied: new Set<string>() };
}

/** Every root a person can have: each theme and every combination of the picks that set tokens. */
function roots(): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  const axes: [string, readonly string[]][] = [["data-theme", ["", "dark"]],
    ...(["color", "contrast", "font", "background", "corners"] as LookKey[]).map(key => [`data-look-${key}`, ["", ...lookChoices(key).slice(1)]] as [string, readonly string[]])];
  for (const [name, values] of axes) out = out.flatMap(root => values.map(value => (value ? { ...root, [name]: value } : root)));
  return out;
}
/** The root with one pick made: a default carries no attribute. */
function withPick(root: Record<string, string>, key: LookKey, value: string) {
  const next = { ...root };
  delete next[`data-look-${key}`];
  if (value !== lookChoices(key)[0]) next[`data-look-${key}`] = value;
  return next;
}

/** What a pick changes on the page, by the picture's name for it. */
const COLOR = ["--accent", "--accent-bright", "--accent-dim", "--accent-wash", "--bg", "--bg-hover", "--bg-panel", "--bg-raised",
  "--border", "--border-strong", "--divider", "--fg", "--fg-faint", "--fg-muted", "--focus", "--on-accent", "--shadow", "--swatch-border"];
const PICTURED: Partial<Record<LookKey, string[]>> = {
  color: [...COLOR, "--picture-sheet"],
  contrast: ["--border", "--border-strong", "--divider", "--fg-faint", "--fg-muted"],
  font: ["--font-ui"],
  corners: ["--radius", "--radius-card", "--radius-control", "--radius-lg", "--radius-rail", "--radius-sm"],
  background: ["--picture-sheet"],
};
const pageToken = (token: string) => (token === "--picture-sheet" ? "--sheet" : token);

describe("the pictures' tokens", () => {
  const all = roots();

  it("cover every look a person can have", () => {
    expect(all).toHaveLength(2 * 4 * 2 * 2 * 4 * 2);
  });

  it("show each picture's own option exactly as the page would carry it, the rest in the person's look", () => {
    for (const [key, tokens] of Object.entries(PICTURED) as [LookKey, string[]][]) {
      for (const value of lookChoices(key)) for (const root of all) {
        const page = withPick(root, key, value);
        for (const token of tokens) {
          const expected = onTheRoot(pageToken(token), page);
          const shown = onThePicture(token, root, key, value);
          expect(shown.value, `${key}=${value} ${token} under ${JSON.stringify(root)}`).toBe(expected);
          expect(shown.tied.size, `${key}=${value} ${token} tied under ${JSON.stringify(root)}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("set nothing outside what their pick changes, and no status or data colour", () => {
    for (const rule of PICTURE_RULES) {
      const [key] = rule.picture!;
      expect(LOOK_KEYS, key).toContain(key);
      for (const token of rule.tokens.keys()) expect(PICTURED[key as LookKey] ?? [], `${key} ${token}`).toContain(token);
    }
    expect(PICTURE_RULES.length).toBeGreaterThan(40);
  });

  it("name only files that exist", () => {
    const urls = [...PICTURE_SHEET.matchAll(/url\("(\/[^"]+)"\)/g)].map(match => match[1]);
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) expect(existsSync(`public${url}`), url).toBe(true);
  });
});

describe("the pictures' drawings", () => {
  const drawings = readFileSync("src/components/settings/LookPictures.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** How many times a background rule lays the picture's sheet. */
  const layers = (pattern: string) => {
    const body = new RegExp(`\\.backgroundArt\\[data-picture-background="${pattern}"\\]\\s*\\{([^}]*)\\}`).exec(drawings)?.[1] ?? "";
    return /background-image:([^;]*)/.exec(body)?.[1].match(/var\(--picture-sheet\)/g)?.length ?? 0;
  };

  it("lay each Background picture's texture several times over, so a small picture reads, and Plain none", () => {
    expect(layers("atlantic")).toBe(6);
    expect(layers("graticule")).toBe(5);
    expect(layers("hex")).toBe(4);
    expect(layers("plain")).toBe(0);
  });

  it("draw each pick's every option, carrying the option it shows", () => {
    for (const key of PICTURE_PICKS) for (const value of lookChoices(key)) {
      const html = renderToStaticMarkup(<LookPicture pick={key} value={value} />);
      expect(html, `${key}=${value}`).toContain(`data-picture-${key}="${value}"`);
      expect(html, `${key}=${value}`).not.toMatch(/—/);
    }
  });
});
