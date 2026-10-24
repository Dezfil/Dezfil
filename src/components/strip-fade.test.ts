import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The strip's fade, read from the gallery's stylesheet: it stands over
 * every strip and leaves only one whose own image is marked as drawn, so
 * the placeholder, a workflow's graph and a dataset's motif keep it; a map
 * template's place stands on a glass label on the overlay surface.
 */

const GALLERY = readFileSync("src/components/gallery.module.css", "utf8");

/** Every top-level rule: its selector and its declarations. */
const RULES = [...GALLERY.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));
const rule = (selector: string) => {
  const found = RULES.filter((r) => r.selector === selector);
  expect(found, `${selector} once in the gallery's stylesheet`).toHaveLength(1);
  return found[0].body;
};

describe("the strip's fade", () => {
  it("stands over every strip", () => {
    expect(rule(".strip::after")).toMatch(/background:\s*linear-gradient\(/);
  });

  it("leaves only a strip whose own image is marked as drawn", () => {
    const dropping = RULES.filter((r) => /\.strip\b[^,]*::after/.test(r.selector) && /content:\s*none/.test(r.body)).map((r) => r.selector);
    expect(dropping).toEqual([".strip:has(> img[data-loaded])::after"]);
  });
});

describe("a map template's place label", () => {
  it("stands on the overlay surface's glass, in the text colour", () => {
    const body = rule(".placeLabel");
    for (const token of ["fill", "blur", "shadow"]) {
      expect(body).toMatch(new RegExp(`var\\(--surface-overlay-control-${token}\\)`));
    }
    expect(body).toMatch(/(^|[;\s])color:\s*var\(--fg\);/);
  });
});
