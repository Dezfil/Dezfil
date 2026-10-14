import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The templates below on Home, worked out from the live stylesheets at
 * every window width above the galleries' narrow width, with the side
 * menu at rest and standing open. The row holds as many of the Templates
 * page's cards as Home's own width allows without drawing one narrower
 * than the floor, so a side menu standing open takes a column away as a
 * narrower window does; at the windows the page is drawn for, with the
 * side menu at rest, four stand in a row. Only the floor is a product
 * fact here: the card as the Showroom reference draws it four to a row at
 * a 1280px window, the narrowest window Home is drawn for, rounded down so
 * a classic scrollbar taking its room keeps four there. Every other number
 * is read from the stylesheets.
 */
const FLOOR = 270;

const HOME = readFileSync("src/components/home/Home.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const LAYOUT = readFileSync("src/app/(workspace)/layout.module.css", "utf8");
const LOOK = readFileSync("src/app/look.css", "utf8");
const GLOBALS = readFileSync("src/app/globals.css", "utf8");

function num(source: string, pattern: RegExp, what: string): number {
  const m = source.match(pattern);
  expect(m, `${what} not found where this check expects it`).not.toBeNull();
  return Number(m![1]);
}

// The page: the content's side margins below the widest windows, the
// side menu's added width when it stands open, and the classic scrollbar.
const NARROW = LAYOUT.slice(LAYOUT.indexOf("@media (max-width: 1720px)"));
const mainLeft = num(NARROW, /\.main\s*{[^}]*margin-left:\s*calc\((\d+)px \+ var\(--rail-shift\)\)/, "the content's left margin");
const mainRight = num(NARROW, /\.main\s*{[^}]*margin-right:\s*(\d+)px/, "the content's right margin");
const mainCap = num(NARROW, /\.main\s*{[^}]*max-width:\s*(\d+)px/, "the content's cap");
const railOpen = num(LOOK, /:root\[data-look-rail="open"\]\s*{[^}]*--rail-shift:\s*(\d+)px/, "the open side menu's shift");
const scrollbar = num(GLOBALS, /::-webkit-scrollbar\s*{[^}]*width:\s*(\d+)px/, "the scrollbar's width");

/** The column count a rule's grid template gives. */
function columns(body: string): number | null {
  const m = /\.shelf\s*{[^}]*grid-template-columns:\s*([^;}]+)/.exec(body);
  if (!m) return null;
  const repeat = /^repeat\((\d+),/.exec(m[1].trim());
  return repeat ? Number(repeat[1]) : m[1].trim().split(/\s+(?![^(]*\))/).length;
}

/** The shelf's own rule and each step after it: which width it reads (the
 * window's for a media query, the named container's otherwise), its bound
 * and its column count. */
const base = columns(HOME);
const gap = num(HOME, /\.shelf\s*{[^}]*gap:\s*(\d+)px/, "the shelf's gap");
const steps: { kind: string; max: number; count: number }[] = [];
for (const m of HOME.matchAll(/@(media|container)\s*([a-z-]*)\s*\(max-width:\s*(\d+)px\)\s*\{([^{}]*\{[^{}]*\})*[^{}]*\}/g)) {
  const count = columns(m[0]);
  if (count !== null) steps.push({ kind: m[1] === "media" ? "window" : m[2], max: Number(m[3]), count });
}

/** Home's width and the shelf's cards at a window width, the side menu adding `shift`. */
function shelfAt(window: number, shift: number) {
  const home = Math.min(mainCap, window - scrollbar - mainLeft - shift - mainRight);
  let count = base!;
  // The narrowest step that holds wins, as the later, narrower rules do.
  for (const step of [...steps].sort((a, b) => b.max - a.max)) {
    if ((step.kind === "window" ? window : step.kind === "home" ? home : Infinity) <= step.max) count = step.count;
  }
  return { home, count, card: (home - gap * (count - 1)) / count };
}

describe("the templates below on Home", () => {
  it("are read: four columns and the steps under them", () => {
    expect(base).toBe(4);
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  it("never draw a card narrower than the floor, from the galleries' narrow width up, the side menu open or not", () => {
    const narrow: string[] = [];
    for (const shift of [0, railOpen]) {
      for (let window = 701; window <= 1720; window += 1) {
        const at = shelfAt(window, shift);
        if (at.card < FLOOR) narrow.push(`${window}px${shift ? " (menu open)" : ""}: ${at.count} of ${at.card.toFixed(1)}px`);
      }
    }
    expect(narrow.slice(0, 6), `${narrow.length} widths too narrow`).toEqual([]);
  });

  it("stand four to a row at the windows the page is drawn for, with the side menu at rest", () => {
    for (const window of [1280, 1440]) expect([window, shelfAt(window, 0).count]).toEqual([window, 4]);
  });

  it("step on Home's own width, so the side menu standing open takes a column away as a narrower window does", () => {
    expect(steps.every((step) => step.kind === "home"), JSON.stringify(steps)).toBe(true);
    expect(shelfAt(1280, railOpen).count).toBeLessThan(shelfAt(1280, 0).count);
  });
});
