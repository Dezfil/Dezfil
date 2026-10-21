// The specimen is fed from the component library, so
// the feed must be shown to (a) namespace kit CSS without touching a
// declaration, (b) replace only what sits between markers, and (c) go red
// the moment a fed source changes without regeneration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import { namespaceModule, apply, rampJs, surfaceBlock, surfacePlate, surfacePlateJs } from "../../scripts/build-specimen.mjs";

const marker = (name: string, body = "") =>
  `/* wheelhouse:feed ${name} start */\n${body}\n/* wheelhouse:feed ${name} end */`;

describe("namespaceModule", () => {
  it("prefixes class selectors and leaves declarations untouched", () => {
    const css = [
      ".btn {",
      "  border-radius: var(--radius);",
      "  transition: background 0.13s;",
      "}",
      ".btn:hover { background: var(--accent-bright); }",
    ].join("\n");
    const out = namespaceModule(css, "Button");
    expect(out).toContain(".kit-button-btn {");
    expect(out).toContain(".kit-button-btn:hover {");
    // The values are the shipped ones, verbatim — the point of the feed.
    expect(out).toContain("border-radius: var(--radius);");
    expect(out).toContain("transition: background 0.13s;");
  });

  it("does not rename inside a declaration value", () => {
    const out = namespaceModule(".a { background: url(./x.svg); }", "Field");
    expect(out).toContain("url(./x.svg)");
  });

  it("namespaces every line of a multi-line selector list", () => {
    // The escape a line-oriented pass allowed: a non-final selector line
    // carrying a pseudo-class was skipped, feeding a GLOBAL `.hint` rule
 // into the page. Found by the authored-refresh round.
    const css = ".hint:hover::after,\n.hint:focus-visible::after {\n  opacity: 1;\n}";
    const out = namespaceModule(css, "IconButton");
    expect(out).toContain(".kit-iconbutton-hint:hover::after,");
    expect(out).toContain(".kit-iconbutton-hint:focus-visible::after {");
    expect(out).not.toMatch(/(^|\n)\.hint:/);
  });

  it("leaves an at-rule prelude alone while namespacing the rule inside it", () => {
    const out = namespaceModule("@media (max-width: 600px) {\n  .btn { padding: 0; }\n}", "Button");
    expect(out).toContain("@media (max-width: 600px) {");
    expect(out).toContain(".kit-button-btn {");
  });
});

describe("apply", () => {
  it("replaces only the marked region", () => {
    const page = ["<style>", marker("tokens-light", ":root { --old: 1; }"), "</style>", "<p>authored</p>"].join("\n");
    const out = apply(page, { "tokens-light": ":root { --new: 2; }" });
    expect(out).toContain("--new: 2");
    expect(out).not.toContain("--old: 1");
    // Authored content around the markers survives untouched.
    expect(out).toContain("<p>authored</p>");
    expect(out).toContain("/* wheelhouse:feed tokens-light end */");
  });

  it("refuses to guess when a marker pair is missing", () => {
    expect(() => apply("<style></style>", { "kit-css": ".x{}" })).toThrow(/marker pair/);
  });

  it("goes red when a fed source changed but the page did not", () => {
    // The freshness check is exactly this comparison: regenerate, compare.
    const page = [marker("ramps", "var SEQ = [];")].join("\n");
    const regenerated = apply(page, { ramps: 'var SEQ = [\n  {nm:"Global Warming"}\n];' });
    expect(regenerated).not.toBe(page);
    // …and green once the page carries the regenerated body.
    expect(apply(regenerated, { ramps: 'var SEQ = [\n  {nm:"Global Warming"}\n];' })).toBe(
      regenerated,
    );
  });
});

describe("rampJs", () => {
  it("splits the shipped rows by group and carries their colors", () => {
    const out = rampJs([
      { name: "global_warming", label: "Global Warming", group: "sequential", cb: false, colors: ["#5A1846", "#FFC300"] },
      { name: "rdbu", label: "RdBu", group: "diverging", cb: true, colors: ["#67001f", "#f7f7f7", "#053061"] },
      { name: "bold", label: "Bold", group: "qualitative", cb: false, colors: ["#7f3c8d"] },
    ]);
    expect(out).toContain('nm:"Global Warming"');
    expect(out).toContain('"#5A1846"');
    // The diverging row carries its midpoint index; the others do not.
    expect(out).toMatch(/nm:"RdBu"[^}]*mid:1/);
    expect(out).not.toMatch(/nm:"Bold"[^}]*mid:/);
    // Each group lands in its own array.
    const cat = out.slice(out.indexOf("var CAT"));
    expect(cat).toContain('nm:"Bold"');
    expect(cat).not.toContain('nm:"RdBu"');
  });
});

// The surface roles' block and the plate drawn from it. A small sheet in
// the shipped shape: a rule before it, a comment heading it, one inside it.
const BLOCK = [
  ":root,",
  "[data-look-default] {",
  "  /* the steps */",
  "  --shadow-float: 0 3px 12px var(--shadow);",
  "  --blur-glass: blur(18px);",
  "  --fill-glass: color-mix(in srgb, var(--bg-panel) 93%, transparent);",
  "  --edge-hairline: 1px solid var(--border);",
  "  --surface-page-card-fill: var(--bg-panel);",
  "  --surface-page-card-blur: none;",
  "  --surface-page-card-edge: var(--edge-hairline);",
  "  --surface-page-card-shadow: var(--shadow-float);",
  "  --surface-page-card-shadow-hover: var(--shadow-deep);",
  "  --surface-page-card-corner: var(--radius-card);",
  "  --surface-menu-fill: var(--bg-panel);",
  "  --surface-menu-blur: none;",
  "  --surface-menu-edge: var(--edge-hairline);",
  "  --surface-menu-shadow: var(--shadow-float);",
  "}",
].join("\n");
const SHEET = ":root {\n  --bg: #fff;\n}\n\n/* the roles, held once */\n" + BLOCK + "\n";
const NOTES = {
  "page-card": { nm: "Page card", what: "A card on a page." },
  menu: { nm: "Menu", what: "What opens over something and closes." },
};

describe("surfaceBlock", () => {
  it("takes the one rule that declares the roles, verbatim from its selector list to its closing brace", () => {
    const block = surfaceBlock(SHEET);
    expect(block.text).toBe(BLOCK);
    expect(block.selectors).toEqual([":root", "[data-look-default]"]);
    expect(block.tokens.get("--surface-menu-shadow")).toBe("var(--shadow-float)");
    expect(block.tokens.has("--bg")).toBe(false);
  });

  it("refuses a sheet where no rule declares the roles, or where two do", () => {
    expect(() => surfaceBlock(":root { --bg: #fff; }")).toThrow(/no rule declares/);
    expect(() => surfaceBlock(SHEET + "\n.x { --surface-menu-fill: red; }\n")).toThrow(/more than one rule/);
    // The solid scopes' rule after the block restates roles and is not the block.
    const solid = "\n[data-look-default],\n[data-published-view] {\n  --surface-menu-fill: var(--bg-panel);\n}\n";
    expect(surfaceBlock(SHEET + solid).tokens).toEqual(surfaceBlock(SHEET).tokens);
    expect(() => surfaceBlock(SHEET + solid.replace("[data-published-view]", "[data-view]"))).toThrow(/more than one rule/);
  });
});

describe("surfacePlate", () => {
  it("lists each role in the block's order with its parts as the block states them, a missing corner as none, and its states", () => {
    const plate = surfacePlate(surfaceBlock(SHEET), NOTES);
    expect(plate.roles.map((r: { key: string }) => r.key)).toEqual(["page-card", "menu"]);
    expect(plate.roles[0]).toEqual({
      key: "page-card", nm: "Page card", what: "A card on a page.",
      fill: "var(--bg-panel)", blur: "none", edge: "var(--edge-hairline)", corner: "var(--radius-card)",
      shadow: "var(--shadow-float)", states: [{ nm: "hover", v: "var(--shadow-deep)" }],
    });
    expect(plate.roles[1].corner).toBeNull();
    expect(plate.roles[1].states).toEqual([]);
    expect(plate.steps).toEqual({
      shadow: [{ nm: "float", v: "0 3px 12px var(--shadow)" }],
      blur: [{ nm: "glass", v: "blur(18px)" }],
      fill: [{ nm: "glass", v: "color-mix(in srgb, var(--bg-panel) 93%, transparent)" }],
      edge: [{ nm: "hairline", v: "1px solid var(--border)" }],
    });
  });

  it("refuses a role with no words, words for a role the block lacks, and a role missing one of its parts", () => {
    expect(() => surfacePlate(surfaceBlock(SHEET), { menu: NOTES.menu })).toThrow(/page-card/);
    expect(() => surfacePlate(surfaceBlock(SHEET), { ...NOTES, stage: { nm: "The stage", what: "The map card." } })).toThrow(/stage/);
    const noBlur = SHEET.replace("  --surface-menu-blur: none;\n", "");
    expect(() => surfacePlate(surfaceBlock(noBlur), NOTES)).toThrow(/menu states no blur/);
    // Only a role its words say lies on a panel goes without a blur, and it shows none.
    const onPanel = surfacePlate(surfaceBlock(noBlur), { ...NOTES, menu: { ...NOTES.menu, onPanel: true } });
    expect(onPanel.roles[1].blur).toBe("none");
    const noFill = SHEET.replace("  --surface-menu-fill: var(--bg-panel);\n", "");
    expect(noFill).not.toBe(SHEET);
    expect(() => surfacePlate(surfaceBlock(noFill), { ...NOTES, menu: { ...NOTES.menu, onPanel: true } })).toThrow(/menu states no fill/);
  });

  it("draws the shipped tokens' eleven roles and six steps, each role with its words", () => {
    const plate = surfacePlate(surfaceBlock(readFileSync("src/app/globals.css", "utf8")));
    expect(plate.roles.map((r: { key: string }) => r.key)).toEqual([
      "glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "page-card", "inner-card", "block", "map-card", "menu", "dialog", "stage",
    ]);
    // The block lies on its panel: it states no blur and shows none.
    expect(plate.roles.find((r: { key: string }) => r.key === "block")?.blur).toBe("none");
    expect(plate.steps.shadow.map((s: { nm: string }) => s.nm)).toEqual(["hairline", "float", "overlay", "lift", "deep", "dialog"]);
    for (const role of plate.roles) expect(role.nm.length * role.what.length).toBeGreaterThan(0);
  });
});

describe("surfacePlateJs", () => {
  it("writes the steps and the roles as the page's two arrays, one entry per line", () => {
    const out = surfacePlateJs(surfacePlate(surfaceBlock(SHEET), NOTES));
    const lines = out.split("\n");
    expect(lines[0]).toBe("var SURFACE_STEPS = {");
    expect(out).toContain('  shadow: [{"nm":"float","v":"0 3px 12px var(--shadow)"}],');
    expect(out).toContain("var SURFACE_ROLES = [");
    expect(lines.filter((l: string) => l.startsWith('  {"key":'))).toHaveLength(2);
    expect(out).toContain('"corner":null');
    expect(out).toContain('"states":[{"nm":"hover","v":"var(--shadow-deep)"}]');
  });
});
