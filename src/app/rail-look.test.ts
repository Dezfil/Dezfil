import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Side menu pick in the stylesheets. Always open stands the rail at
 * its open width beside the page, so every site that places content
 * beside the rail moves right by the same shift, and the stage's left edge
 * takes it in its one expression; Icons only and Always open never expand
 * the rail on keyboard focus. The rectangles themselves are the browser
 * round's; what is held here is that no site is left behind.
 */

type Rule = { selector: string; body: string };
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
    selectors.split(",").map(selector => ({ selector: selector.trim().replace(/\s+/g, " "), body })));
}
const read = (file: string) => rules(readFileSync(file, "utf8"));
const declaration = (body: string, property: string) =>
  body.match(new RegExp(`(?:^|[;\\s])${property.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`))?.[1].trim();
const px = (value: string | undefined) => Number(/^(\d+)px$/.exec(value ?? "")?.[1]);

const LAYOUT = "src/app/(workspace)/layout.module.css";
const SHIFT = "var(--rail-shift)";

/** Every site that places content beside the rail, and the property that does it. */
const SITES: [file: string, selector: string, property: string][] = [
  [LAYOUT, ".accountError", "left"],
  ["src/components/builder/MapBuilder.module.css", ".rail", "left"],
  ["src/components/builder/MapBuilder.module.css", ":global(body)", "--stage-left"],
  ["src/components/builder/drawer/RecipeDrawer.module.css", ".drawer", "left"],
  ["src/components/reader/MapReader.module.css", ".failures", "width"],
  ["src/components/sql/SqlConsole.module.css", ".pane", "left"],
  ["src/components/sql/SqlConsole.module.css", ".vsplit", "left"],
  ["src/components/sql/SqlConsole.module.css", ".work", "left"],
  ["src/components/workflow-canvas/WorkflowCanvas.module.css", '.host[data-view="full"]', "--canvas-overlay-left"],
  ["src/components/workflow-canvas/WorkflowCanvas.module.css", '.host[data-view="framed"]', "inset"],
  ["src/components/workflow-canvas/WorkflowCanvas.module.css", ".pane", "left"],
  ["src/components/workflow-canvas/ResultsBand.module.css", '[data-workflow-canvas][data-view="full"] .column', "left"],
];

function sheets(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) return sheets(file);
    return file.endsWith(".module.css") ? [file.split(path.sep).join("/")] : [];
  });
}

describe("the Side menu pick in the stylesheets", () => {
  it("shifts by the open rail's width less the collapsed one, zero by default", () => {
    const layout = read(LAYOUT);
    const collapsed = px(declaration(layout.find(rule => rule.selector === ".rail" && /width/.test(rule.body))!.body, "width"));
    const open = px(declaration(layout.find(rule => rule.selector === ".rail[data-expanded]")!.body, "width"));
    expect(collapsed).toBe(54);
    expect(open).toBe(210);
    const look = read("src/app/look.css");
    const always = look.find(rule => rule.selector === ':root[data-look-rail="open"]');
    expect(px(declaration(always!.body, "--rail-shift"))).toBe(open - collapsed);
    const globals = read("src/app/globals.css").find(rule => rule.selector === ":root")!;
    expect(declaration(globals.body, "--rail-shift")).toBe("0px");
    // Always open is the open width, not the overlay: the glass and its float shadow stay.
    const standing = layout.find(rule => rule.selector === ':global(:root[data-look-rail="open"]) .rail')!;
    expect(px(declaration(standing.body, "width"))).toBe(open);
    expect(declaration(standing.body, "background")).toBeUndefined();
    expect(declaration(standing.body, "box-shadow")).toBeUndefined();
  });

  it("moves every site that places content beside the rail by the shift", () => {
    for (const [file, selector, property] of SITES) {
      const found = read(file).filter(rule => rule.selector === selector && declaration(rule.body, property) !== undefined);
      expect(found.length, `${file} ${selector} ${property}`).toBe(1);
      expect(declaration(found[0].body, property), `${file} ${selector} ${property}`).toContain(SHIFT);
    }
    // The content's left margin in both breakpoints: the narrow one adds the
    // shift, the centred one takes the larger of the rail's clearance and its
    // centring margin.
    const main = read(LAYOUT).filter(rule => rule.selector === ".main" && /margin/.test(rule.body));
    expect(main).toHaveLength(2);
    for (const rule of main) expect(rule.body, rule.body).toContain(SHIFT);
    expect(main.some(rule => /max\(\s*calc\([^)]*var\(--rail-shift\)\)\s*,\s*calc\(\(100% - /.test(rule.body))).toBe(true);
  });

  it("leaves no rail clearance written as a bare literal anywhere else", () => {
    const bare = sheets("src").flatMap(file => rules(readFileSync(file, "utf8"))
      .flatMap(rule => [...rule.body.matchAll(/([\w-]+)\s*:\s*([^;]*\b82px\b[^;]*)/g)]
        .filter(([, property, value]) => property !== "--stage-left-base" && !value.includes(SHIFT))
        .map(([, property, value]) => `${file} ${rule.selector} ${property}: ${value.trim()}`)));
    expect(bare).toEqual([]);
  });

  it("expands the rail on keyboard focus only under Opens on hover", () => {
    const focusRules = read(LAYOUT).filter(rule => rule.selector.includes(".rail:has(:focus-visible)")
      && !/^\s*transition-(duration|delay)[^;]*;\s*transition-(duration|delay)[^;]*;?\s*$/.test(rule.body.trim()));
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of focusRules) {
      expect(rule.selector, rule.selector).toContain(':not([data-look-rail="icons"])');
      expect(rule.selector, rule.selector).toContain(':not([data-look-rail="open"])');
    }
    // Reduced motion quiets those same rules: its focus selectors carry the
    // gate too, or the gated reveal would outweigh them and keep its delay.
    const quieting = read(LAYOUT).filter(rule => rule.selector.includes(".rail:has(:focus-visible)")
      && !focusRules.includes(rule));
    expect(quieting.length).toBeGreaterThanOrEqual(3);
    for (const rule of quieting) expect(rule.selector, rule.selector).toContain(':not([data-look-rail="open"])');
    // Under Always open the labels and the sign-out stand shown.
    const shown = read(LAYOUT).filter(rule => rule.selector.startsWith(':global(:root[data-look-rail="open"])'));
    expect(shown.some(rule => rule.selector.endsWith(".railLabel") && declaration(rule.body, "opacity") === "1")).toBe(true);
    expect(shown.some(rule => rule.selector.endsWith(".accountOut") && declaration(rule.body, "opacity") === "1")).toBe(true);
  });
});
