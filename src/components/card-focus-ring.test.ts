import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The focus ring on a gallery card's link, read from the live stylesheets.
 * The link fills a card that clips its overflow (the picture's rounded
 * corners), so a ring drawn outside the link is cut by the card: none of
 * it shows where the link meets the card's edge, a sliver where the card
 * stands taller than its link. The ring stays the accessibility census's
 * ring (solid, at least 2px) and stands inside the link instead, its
 * corners following the card's, and the picture across the top leaves the
 * ring's band free while the link has focus, since a positioned picture
 * may paint over its parent's ring.
 */

const GLOBALS = readFileSync("src/app/globals.css", "utf8");
const GALLERY = readFileSync("src/components/gallery.module.css", "utf8");

/** The declarations of the first rule whose selector list is exactly
 * `selector`, or null when the stylesheet has none. */
function rule(source: string, selector: string): Record<string, string> | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m"));
  if (!match) return null;
  const declarations: Record<string, string> = {};
  for (const part of match[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return declarations;
}

const px = (value: string | undefined, what: string): number => {
  const m = value?.match(/^(-?\d+(?:\.\d+)?)px$/);
  expect(m, `${what} is a pixel length`).not.toBeNull();
  return Number(m![1]);
};

/** The ring as the focused card link draws it: the global ring, with the
 * link's own focus rule laid over it. */
function cardLinkRing() {
  const global = rule(GLOBALS, ":focus-visible");
  expect(global, "the global focus ring").not.toBeNull();
  const own = rule(GALLERY, ".cardLink:focus-visible") ?? {};
  const outline = (own.outline ?? global!.outline).split(/\s+/);
  return {
    width: px(own["outline-width"] ?? outline[0], "the ring's width"),
    style: own["outline-style"] ?? outline[1],
    offset: px(own["outline-offset"] ?? global!["outline-offset"], "the ring's offset"),
    radius: own["border-radius"] ?? global!["border-radius"],
  };
}

describe("a gallery card's focus ring", () => {
  it("stands on a card that clips its overflow, with the card's radius", () => {
    const card = rule(GALLERY, ".card");
    expect(card?.overflow).toBe("hidden");
    expect(card?.["border-radius"]).toBe("var(--radius-card)");
  });

  it("is the census's ring: solid and at least 2px", () => {
    const ring = cardLinkRing();
    expect(ring.style).toBe("solid");
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });

  it("stands inside the link, so the card's clip cuts none of it", () => {
    const ring = cardLinkRing();
    // How far past the link's edge the ring's outer edge reaches.
    expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
  });

  it("follows the card's corners, so the rounded clip cuts none of them", () => {
    // The ring's outer edge takes the link's radius; the card's clip is its
    // inner edge, one hairline in, so the same radius stands inside it.
    expect(cardLinkRing().radius).toBe("var(--radius-card)");
  });

  it("is left free by the picture across the top while the link has focus", () => {
    const ring = cardLinkRing();
    const strip = rule(GALLERY, ".cardLink:focus-visible .strip");
    const inset = strip?.["clip-path"]?.match(/^inset\((\d+)px (\d+)px (\d+)(?:px)? (\d+)px round /);
    expect(inset, "the picture's clip while the link has focus").not.toBeFalsy();
    const [top, right, bottom, left] = inset!.slice(1).map(Number);
    // Its top and sides give way by the ring's width; its foot meets the
    // card's words, away from the ring.
    expect(top).toBeGreaterThanOrEqual(ring.width);
    expect(right).toBeGreaterThanOrEqual(ring.width);
    expect(left).toBeGreaterThanOrEqual(ring.width);
    expect(bottom).toBe(0);
  });
});
