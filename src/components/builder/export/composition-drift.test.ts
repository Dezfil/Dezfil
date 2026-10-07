import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The JSX opening tag around `marker`: from the `<` before it to the
 * `>` that closes the tag, braces in attribute values skipped. */
function openingTag(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<", at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`no end to the tag around ${marker}`);
}

/**
 * The composition drift guard: both hosts — the card's preview and the
 * bare render route — must render the SHARED export composition. A host
 * that stops using it can drift from the other silently; this fails the
 * moment either does.
 */
describe("export composition — one component, two hosts", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8");

  it("the card hosts the shared composition", () => {
    const card = read("src/components/builder/export/ExportImageCard.tsx");
    expect(card).toMatch(/<ExportComposition\b/);
    expect(card).toMatch(/from "\.\/ExportComposition"/);
  });

  it("the render route hosts the shared composition", () => {
    const route = read("src/app/render/[id]/RenderExportView.tsx");
    expect(route).toMatch(/<ExportComposition\b/);
    expect(route).toMatch(
      /from "@\/components\/builder\/export\/ExportComposition"/,
    );
  });

  it("both hosts hand it every choice the definition carries", () => {
    // The drift this catches is not a second implementation — it is one
    // host forgetting a prop, which makes the roads differ for exactly
    // the definitions that use the new field. Cheap, and it fails the
    // moment a field is added to one host only.
    const card = read("src/components/builder/export/ExportImageCard.tsx");
    const route = read("src/app/render/[id]/RenderExportView.tsx");
    for (const prop of ["outputWidth", "widgetSize", "credit"]) {
      expect(card, `the card must pass ${prop}`).toMatch(
        new RegExp(`${prop}=\\{`),
      );
      expect(route, `the render route must pass ${prop}`).toMatch(
        new RegExp(`${prop}=\\{`),
      );
    }
    // ...and both must size the composition from the definition's scale
    // rather than from anything they measured themselves.
    expect(route).toMatch(/resolveMapScale\(def\)/);
    expect(card).toMatch(/mapScale/);
  });

  it("both hosts assemble map inputs through the null-preserving boundary", () => {
    const card = read("src/components/builder/export/ExportImageCard.tsx");
    const route = read("src/app/render/[id]/RenderExportView.tsx");
    for (const [host, source] of [
      ["card", card],
      ["render route", route],
    ] as const) {
      expect(source, `${host} imports the shared assembler`).toMatch(
        /from ["'].*composition-map-inputs["']/,
      );
      expect(source, `${host} uses the shared assembler`).toMatch(
        /buildCompositionMapInputs\(/,
      );
    }
  });

  it("keeps Dezfil's default look on the nodes the download rasterizes", () => {
    // The download rasterizes the chrome layer and the standalone legend's
    // scale node with their computed styles, and the preview shows the
    // same nodes: each carries the look's default scope, as the frame
    // around them does (the frame's mono rule reads the UI face, so the
    // scope must sit there too or the person's typeface reaches it).
    const source = read("src/components/builder/export/ExportComposition.tsx");
    for (const marker of ["className={styles.frame}", "ref={chromeRef}", "ref={setLegendScaleEl}"]) {
      expect(openingTag(source, marker), marker).toMatch(/\sdata-look-default=""/);
    }
    // ...and those are the very nodes the card hands the download.
    const card = read("src/components/builder/export/ExportImageCard.tsx");
    expect(card).toMatch(/chrome: chromeRef\.current/);
    expect(card).toMatch(/const standaloneLegend = legendScaleRef\.current/);
    expect(card).toMatch(/chromeRef=\{chromeRef\}/);
    expect(card).toMatch(/legendScaleRef=\{legendScaleRef\}/);
  });

  it("no second frame implementation exists beside the composition", () => {
    // The frame's own selector is the composition's alone: neither host
    // re-declares the export frame styles.
    const card = read("src/components/builder/export/ExportImageCard.module.css");
    expect(card).not.toMatch(/^\.frame\s*\{/m);
  });
});
