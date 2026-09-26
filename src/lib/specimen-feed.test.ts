// The specimen is fed from the component library, so
// the feed must be shown to (a) namespace kit CSS without touching a
// declaration, (b) replace only what sits between markers, and (c) go red
// the moment a fed source changes without regeneration.
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import { namespaceModule, apply, rampJs } from "../../scripts/build-specimen.mjs";

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
