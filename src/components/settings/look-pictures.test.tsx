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

/** A rule on the root or on a picture: the root's attributes it keys on (a
 * value, or with `~=` a word of it), the picture it dresses, the at-rule it
 * sits in (a request from the computer, a feature test), or none. */
type Rule = {
  root: Record<string, string>; words: Record<string, string>; picture: [key: string, value: string | null] | null;
  specificity: number; order: number; tokens: Map<string, string>; within: string | null;
};

function parse(css: string, offset: number): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let order = offset, within: string | null = null, start = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "}") { within = null; start = at + 1; continue; }
    if (text[at] !== "{") continue;
    const head = text.slice(start, at).trim().replace(/\s+/g, " ");
    if (head.startsWith("@")) { within = head; start = at + 1; continue; }
    const close = text.indexOf("}", at);
    const tokens = new Map<string, string>();
    for (const declaration of text.slice(at + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    order += 1;
    for (const raw of head.split(",")) {
      const selector = raw.trim();
      const rooted = /^:root((?:\[[\w-]+~?="[^"]*"\])*)(?: \[data-picture-([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
      // A picture named alone: the shipped roles' block, the request's opaque glass.
      const bare = /^\[data-picture-([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (!rooted && !bare) continue;
      const root: Record<string, string> = {}, words: Record<string, string> = {};
      for (const [, name, word, value] of (rooted?.[1] ?? "").matchAll(/\[([\w-]+)(~?)="([^"]*)"\]/g)) (word ? words : root)[name] = value;
      const picture: Rule["picture"] = rooted ? (rooted[2] ? [rooted[2], rooted[3] ?? null] : null) : [bare![1], bare![2] ?? null];
      const keys = Object.keys(root).length + Object.keys(words).length;
      out.push({ root, words, picture, specificity: (rooted ? 1 : 0) + keys + (picture ? 1 : 0), order, tokens, within });
    }
    at = close;
    start = close + 1;
  }
  return out;
}

const ROOT_RULES = [...parse(readFileSync("src/app/globals.css", "utf8"), 0), ...parse(readFileSync("src/app/look.css", "utf8"), 100_000)]
  .filter(rule => rule.picture === null && rule.within === null);
const PICTURE_SHEET = readFileSync("src/components/settings/look-pictures.css", "utf8");
const PICTURE_RULES = parse(PICTURE_SHEET, 0).filter(rule => rule.picture !== null && rule.within === null);

const onRoot = (rule: Rule, root: Record<string, string>) => Object.entries(rule.root).every(([name, value]) => root[name] === value)
  && Object.entries(rule.words).every(([name, word]) => (root[name] ?? "").split(" ").includes(word));

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

/* ---- Panels: the look's own stylesheets dress its pictures ---- */

const SHEETS_OF_THE_LOOK: [string, number][] = [
  ["src/app/globals.css", 0], ["src/app/look.css", 100_000], ["src/app/look-liquid.css", 200_000], ["src/app/look-paper.css", 300_000],
];
const lookRules = (sheets: Record<string, string> = {}) =>
  SHEETS_OF_THE_LOOK.flatMap(([file, offset]) => parse(sheets[file] ?? readFileSync(file, "utf8"), offset));
/** The computer's request for less transparency or more contrast. */
const REQUEST = "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)";
const VOCABULARY = /^--(shadow|blur|fill|edge|surface)-/;
/** What the Panels pictures draw with: the header card and the side menu
 * on the chrome's role, the card over the map on the overlay panel's. */
const PANELS_PARTS = ["glass-chrome", "overlay-panel"].flatMap(role => ["fill", "blur", "edge", "shadow"].map(part => `--surface-${role}-${part}`));

/** A token as the browser resolves it on the root, or on a Panels picture
 * of `value` inside it, under a request or none: the vocabulary's own
 * references written out where they resolve, the tones left as named. */
function panelsToken(rules: Rule[], token: string, root: Record<string, string>, request: boolean, value: string | null): string {
  const live = (rule: Rule) => rule.tokens.has(token) && onRoot(rule, root) && (rule.within === null || (request && rule.within === REQUEST));
  const own = value === null ? null
    : winner(rules.filter(rule => live(rule) && rule.picture?.[0] === "panels" && (rule.picture[1] === null || rule.picture[1] === value)), token);
  const found = own ?? winner(rules.filter(rule => live(rule) && rule.picture === null), token);
  if (!found) return `(${token} undeclared)`;
  // A reference resolves where the token is declared: on the picture when it declares it there.
  const at = own ? value : null;
  return found.value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) =>
    (VOCABULARY.test(name) ? panelsToken(rules, name, root, request, at) : whole));
}

/** Where a Panels picture draws other than a page with its Panels picked
 * and the person's Transparency kept, under every look a person can have. */
function panelsProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  const steps = lookChoices("transparency").slice(1).map(step => ({ "data-look-transparency": step }));
  const looks: Record<string, string>[] = [
    {}, { "data-look-panels": "liquid" }, { "data-look-panels": "paper" },
    ...steps.flatMap(step => [step, { "data-look-panels": "liquid", ...step }, { "data-look-panels": "paper", ...step }]),
  ];
  for (const theme of ["", "dark"]) for (const look of looks) for (const request of [false, true]) {
    const root = { ...look, ...(theme ? { "data-theme": theme } : {}) };
    for (const value of lookChoices("panels")) {
      const page: Record<string, string> = { ...(theme ? { "data-theme": theme } : {}) };
      if (value !== "glass") page["data-look-panels"] = value;
      if (look["data-look-transparency"]) page["data-look-transparency"] = look["data-look-transparency"];
      for (const token of PANELS_PARTS) {
        const shown = panelsToken(rules, token, root, request, value), expected = panelsToken(rules, token, page, request, null);
        if (shown !== expected) problems.push(`${value} under ${JSON.stringify(root)}${request ? " asked for less transparency" : ""}: ${token} is ${shown}, not ${expected}`);
      }
    }
  }
  return problems;
}

describe("the Panels pictures", () => {
  it("show their own look's chrome and map panels, as a page with that Panels picked, under every look, step, theme and request", () => {
    expect(panelsProblems(lookRules())).toEqual([]);
  });

  it("show Glass under Liquid, and Liquid and Paper under Glass, at those looks' values", () => {
    const rules = lookRules();
    const on = (root: Record<string, string>, value: string, token: string) => panelsToken(rules, token, root, false, value);
    const liquid = { "data-look-panels": "liquid" };
    expect(on(liquid, "glass", "--surface-glass-chrome-fill")).toBe("color-mix(in srgb, var(--bg-panel) 93%, transparent)");
    expect(on(liquid, "glass", "--surface-glass-chrome-blur")).toBe("blur(18px)");
    expect(on(liquid, "glass", "--surface-overlay-panel-shadow")).toBe("0 8px 26px var(--shadow)");
    expect(on({}, "liquid", "--surface-glass-chrome-fill")).toBe("color-mix(in srgb, #fff 10%, var(--bg-panel) 36%)");
    expect(on({}, "liquid", "--surface-glass-chrome-blur")).toBe("blur(6px)");
    expect(on({}, "liquid", "--surface-overlay-panel-fill")).toBe("color-mix(in srgb, #fff 10%, var(--bg-panel) 36%)");
    expect(on({ "data-theme": "dark" }, "liquid", "--surface-overlay-panel-fill")).toBe("color-mix(in srgb, #000 8%, var(--bg-panel) 54%)");
    expect(on({ "data-theme": "dark" }, "liquid", "--surface-glass-chrome-blur")).toBe("blur(8px)");
    expect(on({}, "liquid", "--surface-glass-chrome-shadow")).toMatch(/^inset 1px 1px 0 rgba\(255, 255, 255, 0\.9\), /);
    expect(on({ "data-theme": "dark" }, "liquid", "--surface-glass-chrome-shadow")).toMatch(/^inset 0 1px 0 rgba\(255, 255, 255, 0\.1\), /);
    // The person's Transparency is kept: the Liquid picture shows their step, the Glass one under Liquid stays Glass.
    const firm = { "data-look-panels": "liquid", "data-look-transparency": "firm" };
    expect(on(firm, "liquid", "--surface-overlay-panel-fill")).toBe("color-mix(in srgb, #fff 10%, var(--bg-panel) 68%)");
    expect(on({ "data-look-transparency": "firm" }, "liquid", "--surface-glass-chrome-fill")).toBe("color-mix(in srgb, #fff 10%, var(--bg-panel) 68%)");
    expect(on({ "data-theme": "dark", "data-look-transparency": "medium" }, "liquid", "--surface-overlay-panel-fill"))
      .toBe("color-mix(in srgb, #000 10%, var(--bg-panel) 62%)");
    expect(on(firm, "glass", "--surface-glass-chrome-fill")).toBe("color-mix(in srgb, var(--bg-panel) 93%, transparent)");
    expect(on({}, "paper", "--surface-glass-chrome-fill")).toBe("color-mix(in oklab, var(--bg-panel) 96%, var(--bg))");
    expect(on({}, "paper", "--surface-overlay-panel-blur")).toBe("none");
    expect(on({ "data-theme": "dark" }, "paper", "--surface-glass-chrome-fill")).toBe("var(--bg-raised)");
  });

  it("fail when the shipped roles are not declared on the Panels pictures: a Glass picture under Liquid would show Liquid", () => {
    const globals = readFileSync("src/app/globals.css", "utf8");
    const dropped = globals.replace(",\n[data-picture-panels] {", " {");
    expect(dropped).not.toBe(globals);
    expect(panelsProblems(lookRules({ "src/app/globals.css": dropped })).join("\n"))
      .toMatch(/^glass under \{"data-look-panels":"liquid"\}: --surface-glass-chrome-fill is color-mix\(in srgb, #fff 10%/m);
  });

  it("draw the header card, the side menu and a card over a small map in data colours, each reading its role", () => {
    for (const value of lookChoices("panels")) {
      const html = renderToStaticMarkup(<LookPicture pick="panels" value={value} />);
      expect(html).toContain(`data-picture-panels="${value}"`);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
      // Global Warming's ramp on the cells, the cycle's teal and pink on a line and its stops.
      for (const color of ["#5A1846", "#C70039", "#FFC300", "#12939A", "#DA70BF"]) expect(html, color).toContain(color);
      expect(html).toContain(">Dezfil<");
    }
    const drawings = readFileSync("src/components/settings/LookPictures.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(drawings)?.[1] ?? "";
    for (const [selector, role] of [[".art .pnHead", "glass-chrome"], [".art .pnRail", "glass-chrome"], [".art .pnCard", "overlay-panel"]]) {
      for (const [property, part] of [["background", "fill"], ["backdrop-filter", "blur"], ["box-shadow", "shadow"]]) {
        expect(rule(selector), `${selector} ${property}`).toContain(`${property}: var(--surface-${role}-${part});`);
      }
    }
  });
});
