import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The export card's type, checked rather than asserted. Two rules given
 * twice in the field — once for the gallery cards, once here
 * — and which kept coming back because a conversation is not a rule:
 *
 * - **Mono is for code.** The SQL editor and code blocks; nothing else.
 *   The card had it on its size chips and its meta line.
 * - **Section headings read like the layer panel's** — sentence case at
 *   normal colour, not faint all-caps. The card had invented its own.
 *
 * Scoped to the export surface: the app-wide sweep is its own change,
 * and a check that fails for files this feature did not touch would be
 * noise rather than a ratchet.
 */

const DIR = "src/components/builder/export";

/** The card's own stylesheets, PLUS the components it composes. The
 * first version of this check scanned only the export directory and
 * passed while the legend and the widget cards — which render inside the
 * card and inside every exported image — still set a monospace face. A check that misses what the user can see is worse
 * than no check. */
const sheets = readdirSync(DIR)
  .filter((f) => f.endsWith(".module.css"))
  .map((f) => path.join(DIR, f))
  .map((file) => ({ file, css: readFileSync(file, "utf8") }));

/** The components the card composes — the legend and the widget cards —
 * set a monospace face in stylesheets shared with the builder and the
 * published viewer. Restyling those would be the app-wide sweep this
 * feature's scope reserves, so the composition overrides the token for
 * everything drawn into an image instead. This is the check that the
 * override exists: without it, mono is visible in every export while a
 * directory-scoped check happily passes. */
const COMPOSITION_CSS = readFileSync(
  path.join(DIR, "ExportComposition.module.css"),
  "utf8",
);

describe("the export card's type follows the app", () => {
  it("finds the card's stylesheets at all (the check is not vacuous)", () => {
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.map((s) => path.basename(s.file))).toContain(
      "ExportImageCard.module.css",
    );

  });

  it("the shared composition and its composed styles hold no mono", () => {
    // contract, superseding two-sided token contract: the legend and
    // widget cards read the UI face OUTRIGHT — no mono face, no
    // override token — on every surface, so the composition composes
    // clean sources. The frame keeps the general mono rebind as the
    // boundary for anything else it ever comes to compose.
    for (const file of [
      "src/components/map/LegendPanel.module.css",
      "src/components/widgets/Widgets.module.css",
    ]) {
      const css = readFileSync(file, "utf8");
      expect(
        css.match(/--font-mono|"SF Mono"|ui-monospace|Cascadia|monospace/),
        `${file} declares a mono face; legend and widget text is chrome`,
      ).toBeNull();
    }
    expect(COMPOSITION_CSS).not.toMatch(/--legend-value-font/);
    expect(COMPOSITION_CSS).toMatch(/--font-mono:\s*var\(--font-ui\)/);
  });

  it("uses no monospace face of its own", () => {
    for (const sheet of sheets) {
      // The composition's own line is the override that REMOVES mono
      // from the image; everything else declaring it would be adding it.
      const declarations = sheet.css.replace(
        /--font-mono:\s*var\(--font-ui\);/g,
        "",
      );
      expect(
        declarations,
        `${sheet.file} sets a monospace face; mono is for code`,
      ).not.toMatch(/--font-mono|monospace/);
    }
  });

  it("has no faint all-caps headings", () => {
    for (const sheet of sheets) {
      expect(
        sheet.css,
        `${sheet.file} upper-cases a label; headings read in sentence case`,
      ).not.toMatch(/text-transform:\s*uppercase/);
    }
  });

  it("would fail if either returned (red-proven on a seeded rule)", () => {
    // The seeded defect: the exact declarations that were removed. If the
    // matchers above were mis-written, these would pass too.
    const seeded = ".x { font-family: var(--font-mono); }";
    const seededCaps = ".y { text-transform: uppercase; }";
    expect(seeded).toMatch(/--font-mono|monospace/);
    expect(seededCaps).toMatch(/text-transform:\s*uppercase/);
  });
});
