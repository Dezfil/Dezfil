import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The export dialog's size holds by specificity, not by stylesheet
 * order. The card's node carries both its own module class and the kit
 * shell's; when the two declared the same property at equal
 * specificity, the winner was whichever stylesheet the bundler emitted
 * later — a silent ~220px shrink waiting on a build-order change. The
 * contract: every property the card declares on the dialog node that
 * the shell also declares must ride a selector of strictly higher
 * specificity, so the cascade is decided by the files' content alone.
 */

const SHELL = "src/components/ui/Dialog.module.css";
const CARD = "src/components/builder/export/ExportImageCard.module.css";
const CATALOG = "src/components/builder/add-layer/AddLayerCatalog.module.css";

/** Rules of a stylesheet as [selector, declaration block] pairs. */
function rules(css: string): Array<{ selector: string; block: string }> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; block: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(noComments); m; m = re.exec(noComments)) {
    out.push({ selector: m[1].trim(), block: m[2] });
  }
  return out;
}

/** Property names declared in a block. */
function properties(block: string): string[] {
  return [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
}

/** Class + attribute count — the specificity tier both files play in. */
function specificity(selector: string): number {
  return (
    (selector.match(/\.[\w-]+/g) ?? []).length +
    (selector.match(/\[[^\]]*\]/g) ?? []).length
  );
}

/** Rules addressing the dialog node itself (no combinator, no child). */
function dialogNodeRules(css: string) {
  return rules(css).filter(
    (r) =>
      /^\.dialog(?![\w-])/.test(r.selector) && !/[\s>+~]/.test(r.selector),
  );
}

/** The violations: card properties competing with the shell's at a
 * specificity that leaves the winner to stylesheet order. */
function orderDecided(shellCss: string, cardCss: string): string[] {
  const shellRule = rules(shellCss).find((r) => r.selector === ".dialog");
  const shellProps = new Set(properties(shellRule?.block ?? ""));
  const found: string[] = [];
  for (const rule of dialogNodeRules(cardCss)) {
    if (specificity(rule.selector) > 1) continue;
    for (const prop of properties(rule.block)) {
      if (shellProps.has(prop)) found.push(`${rule.selector} { ${prop} }`);
    }
  }
  return found;
}

const shellCss = readFileSync(SHELL, "utf8");
const cardCss = readFileSync(CARD, "utf8");

describe("the export dialog's size survives stylesheet order", () => {
  it("finds both parties to the cascade (the check is not vacuous)", () => {
    expect(rules(shellCss).find((r) => r.selector === ".dialog")).toBeTruthy();
    const cardProps = dialogNodeRules(cardCss).flatMap((r) =>
      properties(r.block),
    );
    for (const prop of ["width", "height", "max-height"]) {
      expect(cardProps, `the card no longer sizes its dialog (${prop})`)
        .toContain(prop);
    }
    // The competition is real: the shell caps the same properties.
    const shellProps = properties(
      rules(shellCss).find((r) => r.selector === ".dialog")!.block,
    );
    expect(shellProps).toContain("width");
    expect(shellProps).toContain("max-height");
  });

  it("leaves no dialog-node property to be decided by import order", () => {
    expect(orderDecided(shellCss, cardCss)).toEqual([]);
  });

  it("takes the catalog's widest frame, byte for byte", () => {
    const catalogWide = rules(readFileSync(CATALOG, "utf8")).find(
      (r) => r.selector === ".dialog[data-wide]",
    );
    expect(catalogWide).toBeTruthy();
    const size = (block: string, prop: "width" | "height") =>
      block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
    const cardBlock = dialogNodeRules(cardCss)
      .map((r) => r.block)
      .join(";");
    expect(size(cardBlock, "width")).toBe(size(catalogWide!.block, "width"));
    expect(size(cardBlock, "height")).toBe(size(catalogWide!.block, "height"));
  });

  it("would fail on the earlier shape (red-proven on the seeded defect)", () => {
    // The seed IS the shape this feature replaced: a bare.dialog class declaring width and max-
    // height against the shell's bare.dialog.
    const seededCard = ".dialog { width: min(1060px, 100%); max-height: none; }";
    expect(orderDecided(shellCss, seededCard)).toEqual([
      ".dialog { width }",
      ".dialog { max-height }",
    ]);
  });
});
