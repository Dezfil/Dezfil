import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The template lead's words column, worked out from the live stylesheets
 * at every window width above the galleries' narrow width, with the side
 * menu opening on hover and standing open. Its actions stand at the
 * right of its words, in room the words leave for them, until the card is
 * too narrow for both; Start stands beside the lead until Home is too
 * narrow for both. Wherever those two steps fall, the words never stand
 * in a column narrower than a Templates card's own words: a title of the
 * catalogue's length wraps at most once there, never to a third line
 * beside the actions. Only that floor is a product fact here; every
 * other number is read from the stylesheets.
 */

const HOME = readFileSync("src/components/home/Home.module.css", "utf8");
const GALLERY = readFileSync("src/components/gallery.module.css", "utf8");
const LAYOUT = readFileSync("src/app/(workspace)/layout.module.css", "utf8");
const LOOK = readFileSync("src/app/look.css", "utf8");
const GLOBALS = readFileSync("src/app/globals.css", "utf8");

function num(source: string, pattern: RegExp, what: string): number {
  const m = source.match(pattern);
  expect(m, `${what} not found where this check expects it`).not.toBeNull();
  return Number(m![1]);
}

/** The block of each at-rule `@media (max-width: Npx)` or
 * `@container <name> (max-width: Npx)`, with its braces matched. */
function steps(source: string): { kind: "window" | string; max: number; body: string }[] {
  const found: { kind: string; max: number; body: string }[] = [];
  const head = /@(media|container)\s*([a-z-]*)\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  for (let m = head.exec(source); m; m = head.exec(source)) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    found.push({ kind: m[1] === "media" ? "window" : m[2], max: Number(m[3]), body: source.slice(head.lastIndex, i - 1) });
  }
  return found;
}

/** The step at which a rule in its block holds: the window's width for a
 * media query, the named container's for a container query. */
function stepFor(selector: RegExp, declaration: RegExp, what: string) {
  const step = steps(HOME).find((s) => {
    const block = s.body.match(selector);
    return block !== null && declaration.test(s.body.slice(block.index!).split("}")[0]);
  });
  expect(step, `${what} not found where this check expects it`).toBeDefined();
  return step!;
}

// The page: the content's side margins below the widest windows, the
// side menu's added width when it stands open, and the classic scrollbar
// a scrolling page takes from the window.
const NARROW_AT = LAYOUT.indexOf("@media (max-width: 1720px)");
const NARROW = LAYOUT.slice(NARROW_AT);
const mainLeft = num(NARROW, /\.main\s*{[^}]*margin-left:\s*calc\((\d+)px \+ var\(--rail-shift\)\)/, "the content's left margin");
const mainRight = num(NARROW, /\.main\s*{[^}]*margin-right:\s*(\d+)px/, "the content's right margin");
const mainCap = num(NARROW, /\.main\s*{[^}]*max-width:\s*(\d+)px/, "the content's cap");
const railOpen = num(LOOK, /:root\[data-look-rail="open"\]\s*{[^}]*--rail-shift:\s*(\d+)px/, "the open side menu's shift");
const scrollbar = num(GLOBALS, /::-webkit-scrollbar\s*{[^}]*width:\s*(\d+)px/, "the scrollbar's width");
const edge = num(GLOBALS, /--edge-hairline:\s*(\d+)px/, "a card's edge");

// A Templates card's own words: its gallery track, less its edges and
// its body's side padding.
const track = num(GALLERY, /\.grid\s*{[^}]*repeat\(auto-fill,\s*(\d+)px\)/, "the gallery's track");
const cardSide = num(GALLERY, /\.cardBody\s*{[^}]*padding:\s*\d+px (\d+)px/, "a card body's side padding");
const FLOOR = track - 2 * edge - 2 * cardSide;

// Home: Start's column and the gap beside the lead, the lead's words'
// padding and the room they leave for the actions.
const startColumn = num(HOME, /\.leadRow\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) (\d+)px/, "Start's column");
const rowGap = num(HOME, /\.leadRow\s*{[^}]*gap:\s*(\d+)px/, "the lead row's gap");
const bodyLeft = num(HOME, /\.leadBody\s*{[^}]*padding:\s*\d+px (\d+)px/, "the lead's words' left padding");
const actionsRoom = num(HOME, /\.leadBody\s*{[^}]*padding-right:\s*(\d+)px/, "the room left for the actions");

const startUnder = stepFor(/\.leadRow\s*,|\.leadRow\s*{/, /grid-template-columns:\s*minmax\(0, 1fr\)\s*;/, "the step where Start goes under the lead");
const actionsUnder = stepFor(/\.leadActs\s*{/, /position:\s*static/, "the step where the actions go under the words");
const narrowRight = num(actionsUnder.body, /\.leadBody\s*{[^}]*padding-right:\s*(\d+)px/, "the words' right padding with the actions under them");

/** The words' column at a window width, the side menu adding `shift`. */
function wordsAt(window: number, shift: number) {
  const home = Math.min(mainCap, window - scrollbar - mainLeft - shift - mainRight);
  const holds = (step: { kind: string; max: number }, card: number) =>
    step.kind === "window" ? window <= step.max : (step.kind === "home" ? home : card) <= step.max;
  const under = holds(startUnder, home);
  const card = under ? home : home - startColumn - rowGap;
  const below = holds(actionsUnder, card);
  return { home, card, under, below, words: card - 2 * edge - bodyLeft - (below ? narrowRight : actionsRoom) };
}

describe("the template lead's words", () => {
  it("are measured against a Templates card's own words column", () => {
    expect(FLOOR).toBe(312);
  });

  it("never stand narrower than a Templates card's words, from the galleries' narrow width up, the side menu open or not", () => {
    const narrow: string[] = [];
    for (const shift of [0, railOpen]) {
      for (let window = 701; window <= 1720; window += 1) {
        const at = wordsAt(window, shift);
        if (at.words < FLOOR) narrow.push(`${window}px${shift ? " (menu open)" : ""}: ${at.words}px`);
      }
    }
    expect(narrow.slice(0, 6), `${narrow.length} widths too narrow`).toEqual([]);
  });

  it("keep their actions beside them at the windows the page is drawn for, the side menu open or not", () => {
    for (const shift of [0, railOpen]) {
      for (const window of [1280, 1440]) {
        expect([window, shift, wordsAt(window, shift).under, wordsAt(window, shift).below]).toEqual([window, shift, false, false]);
      }
    }
  });
});
