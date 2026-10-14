// Every wheelhouse rule must be demonstrably red on a violating
// fixture and green on a clean one, and the inventory ratchet must fail
// in both directions — a lint nobody has seen fail is not evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import {
  sweepTree,
  sweepStyles,
  sweepGlyphs,
  sweepOutline,
  sweepNames,
  sweepSpecimen,
  sweepCursor,
  sweepSurfaces,
  toRows,
  judge,
  judgeSurfaceNames,
  inventoryText,
} from "../../scripts/check-wheelhouse.mjs";

type Finding = { file: string; rule: string; value: string; line: number };
type Row = { file: string; rule: string; value: string; count: number; exception?: string };
const rules = (found: Finding[]) => found.map((f) => f.rule).sort();

describe("sweepStyles", () => {
  it("is red on off-ramp, off-family, off-beat, off-curve, raw-color", () => {
    const css = [
      ".a { font-size: 10px; }",
      ".b { border-radius: 7px; }",
      ".c { transition: opacity 0.5s ease-in-out; }",
      "d { color: #ff0000; }",
    ].join("\n");
    expect(rules(sweepStyles(css, "x.module.css"))).toEqual([
      "color",
      "duration",
      "easing",
      "font-size",
      "radius",
    ]);
  });

  it("is green on the ramp, the family, the beats, and tokens", () => {
    const css = [
      ".a { font-size: var(--text-body); }",
      ".b { font-size: 11px; }",
      ".c { border-radius: var(--radius); }",
      ".d { border-radius: var(--radius) var(--radius) 0 0; }",
      ".e { transition: opacity var(--dur-micro); }",
      ".f { transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); }",
      ".g { color: var(--fg); background: var(--accent-dim); }",
      ".h { border-radius: 50%; }",
    ].join("\n");
    expect(sweepStyles(css, "x.module.css")).toEqual([]);
  });

  it("flags a literal radius the family's tokens carry, so the person's Corners reach it; pills and rounds stay literal", () => {
    for (const literal of ["4px", "9px", "12px", "14px", "20px", "9px 9px 0 0", "0 12px"]) {
      expect(rules(sweepStyles(`.a { border-radius: ${literal}; }`, "x.module.css")), literal).toEqual(["radius"]);
    }
    expect(rules(sweepStyles(".a { border-top-left-radius: 14px; }", "x.module.css"))).toEqual(["radius"]);
    for (const kept of ["999px", "50%", "0", "999px 999px 0 0"]) {
      expect(sweepStyles(`.a { border-radius: ${kept}; }`, "x.module.css"), kept).toEqual([]);
    }
  });

  it("flags a raw color even when a custom property carries it", () => {
    // This asserted the opposite until a review showed the bypass: `--spark: #123456` then `color: var(--spark)` is the
    // same off-token color, one hop away.
    expect(rules(sweepStyles(".a { --spark: #123456; }", "x.module.css"))).toEqual([
      "color",
    ]);
  });
});

describe("sweepGlyphs", () => {
  it("is red on a banned chrome glyph and green on drawn-icon markup", () => {
    expect(rules(sweepGlyphs("<span>▸</span>", "x.tsx"))).toEqual(["glyph"]);
    expect(sweepGlyphs('<CaretIcon aria-hidden />', "x.tsx")).toEqual([]);
  });
});

describe("sweepOutline", () => {
  it("is red on a suppression and green on the recorded Dialog exception", () => {
    expect(rules(sweepOutline(".a { outline: none; }", "x.module.css"))).toEqual([
      "outline",
    ]);
    expect(
      sweepOutline(".a { outline: none; }", "src/components/ui/Dialog.module.css"),
    ).toEqual([]);
  });
});

describe("sweepNames", () => {
  it("is red on an unnamed role container and an unlabeled icon-only button", () => {
    const tsx = [
      '<div role="group"><p>hi</p></div>',
      "<button onClick={x}><TrashIcon /></button>",
    ].join("\n");
    expect(rules(sweepNames(tsx, "x.tsx"))).toEqual(["name", "name"]);
  });

  it("is green on named containers and text or labeled buttons", () => {
    const tsx = [
      '<div role="group" aria-label="Filters">…</div>',
      '<nav aria-label="Product navigation">…</nav>',
      '<button aria-label="Delete row"><TrashIcon /></button>',
      "<button onClick={x}>Save</button>",
    ].join("\n");
    expect(sweepNames(tsx, "x.tsx")).toEqual([]);
  });
});

// The arrow cursor means disabled, and globals.css says so once for every
// button. A component rule that puts the arrow on anything else is either
// a recorded exception or a clickable that lost its pointer (the workflow
// results tabs), so every such rule is held against the inventory by
// selector.
describe("sweepCursor", () => {
  const values = (css: string) => sweepCursor(css, "x.module.css").map((f) => f.value);

  it("is red on an arrow rule whose selector does not say disabled", () => {
    const out = sweepCursor(".tab { color: red; cursor: default; }", "x.module.css");
    expect(out).toEqual([{ file: "x.module.css", rule: "cursor", value: ".tab", line: 1 }]);
  });

  it("is green on the convention: a selector that says disabled itself", () => {
    const css = [
      ".btn:disabled { cursor: default; }",
      '.check[data-disabled="true"] { cursor: default; }',
      ".row:has(.switch:disabled) { cursor: default; }",
      '.door[aria-disabled="true"] { cursor: default; }',
      ".histBtn:disabled, .histBtn:disabled:hover { cursor: default; }",
    ].join("\n");
    expect(values(css)).toEqual([]);
  });

  it("judges a selector list part by part, so a bare part cannot hide behind a disabled one", () => {
    expect(values(".a:disabled,\n.b { cursor: default; }")).toEqual([".b"]);
  });

  it("sees the arrow by its other name and ignores every other cursor", () => {
    expect(values(".z { cursor: auto }")).toEqual([".z"]);
    expect(values(".p { cursor: pointer; } .r { cursor: row-resize; } .n { cursor: not-allowed; }")).toEqual([]);
  });

  it("reads rules inside an at-rule block and not inside a comment", () => {
    expect(values("@media (hover: hover) {\n  .y { cursor: default; }\n}")).toEqual([".y"]);
    expect(values("/* .old { cursor: default; } */\n.new { cursor: pointer; }")).toEqual([]);
  });

  // Found at review, two ways past the sweep, each shown
  // by adding the rule to the results band in memory and watching the
  // check stay green. Only a POSITIVE disabled condition is the convention.
  it("does not exempt a negated or an explicitly false disabled condition", () => {
    expect(values(".tab:hover:not(:disabled) { cursor: default; }")).toEqual([".tab:hover:not(:disabled)"]);
    expect(values('.door[aria-disabled="false"] { cursor: default; }')).toEqual(['.door[aria-disabled="false"]']);
    expect(values(".zone[data-disabled=false] { cursor: default; }")).toEqual([".zone[data-disabled=false]"]);
    expect(values(".x:not(.busy):disabled { cursor: default; }")).toEqual([]);
    expect(values('.y[aria-disabled="true"], .z[data-disabled] { cursor: default; }')).toEqual([]);
  });

  it("sees a declaration carrying !important, the one most able to override the pointer", () => {
    expect(values(".tab { cursor: default !important; }")).toEqual([".tab"]);
    expect(values(".tab { cursor: auto!important }")).toEqual([".tab"]);
    expect(values(".tab { cursor: pointer !important; }")).toEqual([]);
  });

  it("reports the declaration's line and a normalized selector", () => {
    const out = sweepCursor("\n\n.grid\n  td {\n  padding: 0;\n  cursor: default;\n}", "x.module.css");
    expect(out).toEqual([{ file: "x.module.css", rule: "cursor", value: ".grid td", line: 6 }]);
  });
});

describe("the inventory ratchet", () => {
  const found = [
    { file: "a.module.css", rule: "font-size", value: "10px", line: 1 },
    { file: "a.module.css", rule: "font-size", value: "10px", line: 9 },
  ];

  it("collapses to counted rows", () => {
    expect(toRows(found)).toEqual([
      { file: "a.module.css", rule: "font-size", value: "10px", count: 2 },
    ]);
  });

  it("fails a violation the inventory does not carry", () => {
    const problems = judge(toRows(found), []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^NEW: a\.module\.css/);
  });

  it("passes when the inventory carries the exact count", () => {
    const inventory = [
      { file: "a.module.css", rule: "font-size", value: "10px", count: 2 },
    ];
    expect(judge(toRows(found), inventory)).toEqual([]);
  });

  it("fails a stale inventory row when the violation heals", () => {
    const inventory = [
      { file: "a.module.css", rule: "font-size", value: "10px", count: 2 },
      { file: "gone.module.css", rule: "radius", value: "7px", count: 1 },
    ];
    const problems = judge(toRows(found), inventory);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^STALE: gone\.module\.css/);
  });

  it("keeps multi-word values whole through the round trip", () => {
    const curve = [
      { file: "s.module.css", rule: "easing", value: "cubic-bezier(0.25, 1, 0.5, 1)", line: 3 },
    ];
    const rows = toRows(curve);
    expect(rows[0].value).toBe("cubic-bezier(0.25, 1, 0.5, 1)");
    expect(judge(rows, rows)).toEqual([]);
  });

  // The inventory is regenerated on more than one machine; ordering by the
  // machine's locale would reshuffle every row on a rewrite and bury the one
  // row that changed.
  it("orders rows by code point, whatever the machine's locale", () => {
    const rows = toRows([
      { file: "src/b.module.css", rule: "radius", value: "7px", line: 1 },
      { file: "src/C.module.css", rule: "radius", value: "7px", line: 1 },
      { file: "src/C.module.css", rule: "duration", value: "0.5s", line: 2 },
      { file: "src/C.module.css", rule: "Duration", value: "0.5s", line: 3 },
    ]);
    expect(rows.map((r: Row) => r.file + " " + r.rule)).toEqual([
      "src/C.module.css Duration",
      "src/C.module.css duration",
      "src/C.module.css radius",
      "src/b.module.css radius",
    ]);
  });

  it("writes the inventory as ASCII with its rows annotated, so a rewrite changes only the rows that changed", () => {
    const rows = [
      { file: "src/components/HomeScreen.tsx", rule: "glyph", value: "▶", count: 1 },
      { file: "src/app/(workspace)/layout.module.css", rule: "shadow", value: "16px 0 36px -18px var(--shadow)", count: 2 },
    ];
    const text = inventoryText(rows);
    expect(text).toContain('"value": "\\u25b6"');
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
    expect(text.endsWith("]\n")).toBe(true);
    const back = JSON.parse(text) as Row[];
    expect(back.map((r) => ({ file: r.file, rule: r.rule, value: r.value, count: r.count }))).toEqual(rows);
    expect(back[0].exception).toBeUndefined();
    expect(back[1].exception).toMatch(/^Surface exception: the side rail opened over the page/);
  });

  it("finds the committed inventory in the writer's own form: its order, its escapes and its notes", () => {
    const text = readFileSync("scripts/wheelhouse-inventory.json", "utf8");
    const rows = JSON.parse(text) as Row[];
    const findings = rows.flatMap((r) =>
      Array.from({ length: r.count }, () => ({ file: r.file, rule: r.rule, value: r.value, line: 0 })),
    );
    expect(inventoryText(toRows(findings))).toBe(text);
  });
});

// A drop shadow, a background blur and a translucent fill of the panel or
// raised tone are read from the surface vocabulary in globals.css (a role's
// part, a shadow step, a blur strength, a fill), never typed: that is what
// lets one restated role reach every surface that plays it.
describe("sweepSurfaces", () => {
  const found = (css: string) =>
    sweepSurfaces(css, "x.module.css").map((f: Finding) => [f.rule, f.value]);

  it("is red on a typed drop shadow, a typed blur and a typed panel or raised fill", () => {
    const css = [
      ".a { box-shadow: 0 3px 12px var(--shadow); }",
      ".b { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }",
      ".c { background: color-mix(in srgb, var(--bg-panel) 93%, transparent); }",
      ".d { background: color-mix(in srgb, var(--bg-raised) 70%, transparent); }",
    ].join("\n");
    expect(found(css)).toEqual([
      ["shadow", "0 3px 12px var(--shadow)"],
      ["blur", "blur(8px)"],
      ["blur", "blur(8px)"],
      ["fill", "color-mix(in srgb, var(--bg-panel) 93%, transparent)"],
      ["fill", "color-mix(in srgb, var(--bg-raised) 70%, transparent)"],
    ]);
  });

  it("is green on a role's part, a step, a strength and a fill, each read", () => {
    const css = [
      ".a { box-shadow: var(--surface-menu-shadow); }",
      ".b { box-shadow: var(--shadow-lift); }",
      ".c { box-shadow: var(--surface-inner-card-shadow-dragged); }",
      ".d { backdrop-filter: var(--surface-overlay-panel-blur); -webkit-backdrop-filter: var(--blur-veil); }",
      ".e { background: var(--surface-glass-chrome-fill); }",
      ".f { background: var(--fill-wash); }",
      ".g { box-shadow: none; backdrop-filter: none; }",
    ].join("\n");
    expect(found(css)).toEqual([]);
  });

  it("judges a shadow per layer: an inset or an offset-free ring beside a read stays outside, a typed drop beside a read does not", () => {
    expect(found(".a { box-shadow: var(--surface-page-card-shadow), 0 0 0 6px var(--accent-wash); }")).toEqual([]);
    expect(found(".a { box-shadow: 0 0 0 1px var(--accent), var(--surface-menu-shadow); }")).toEqual([]);
    expect(found(".a { box-shadow: inset 0 0 0 1px var(--border), inset 2.5px 0 0 var(--accent); }")).toEqual([]);
    expect(found(".a { box-shadow: 0 0 6px color-mix(in srgb, var(--danger) 70%, transparent); }")).toEqual([]);
    expect(found(".a { box-shadow:\n    var(--shadow-lift),\n    16px 0 36px -18px var(--shadow); }")).toEqual([
      ["shadow", "16px 0 36px -18px var(--shadow)"],
    ]);
  });

  it("leaves the colour-only shadow tone alone: it draws nothing", () => {
    expect(found(".a { box-shadow: var(--shadow); }")).toEqual([]);
  });

  it("leaves fills of the page tone, of the ink, and opaque panel mixes outside the rule", () => {
    expect(found(".a { background: color-mix(in srgb, var(--bg) 85%, transparent); }")).toEqual([]);
    expect(found(".a { background: color-mix(in srgb, var(--fg) 32%, transparent); }")).toEqual([]);
    expect(found(".a { background: color-mix(in srgb, var(--bg-panel) 80%, var(--accent)); }")).toEqual([]);
  });

  it("catches a typed value one hop away in a local custom property, and a fill written the other way round", () => {
    expect(found(".a { --lift: 0 6px 20px var(--shadow); box-shadow: var(--lift); }")).toEqual([
      ["shadow", "0 6px 20px var(--shadow)"],
    ]);
    expect(found(".a { --glass: blur(12px); backdrop-filter: var(--glass); }")).toEqual([["blur", "blur(12px)"]]);
    expect(found(".a { background: linear-gradient(transparent, color-mix(in srgb, transparent, var(--bg-panel) 90%)); }")).toEqual([
      ["fill", "color-mix(in srgb, transparent, var(--bg-panel) 90%)"],
    ]);
  });

  it("reads declarations, not comments, and reports the declaration's line", () => {
    expect(found("/* was box-shadow: 0 2px 8px var(--shadow); */\n.a { color: var(--fg); }")).toEqual([]);
    expect(sweepSurfaces("\n.a {\n  box-shadow:\n    0 3px 12px var(--shadow);\n}", "x.module.css")).toEqual([
      { file: "x.module.css", rule: "shadow", value: "0 3px 12px var(--shadow)", line: 3 },
    ]);
  });
});

// The ratchet on a real stylesheet and the real inventory: the shell's
// stylesheet carries the header card (a role read three times over) and the
// rail opened over the page, whose one side layer is a named exception.
describe("the surface ratchet on the shell's own stylesheet", () => {
  const SHELL = "src/app/(workspace)/layout.module.css";
  const SIDE = "16px 0 36px -18px var(--shadow)";
  const shell = readFileSync(SHELL, "utf8");
  const inventory = (JSON.parse(readFileSync("scripts/wheelhouse-inventory.json", "utf8")) as Row[]).filter(
    (r) => r.file === SHELL,
  );
  const judgeShell = (css: string, rows: Row[] = inventory) =>
    judge(
      toRows([
        ...sweepStyles(css, SHELL),
        ...sweepOutline(css, SHELL),
        ...sweepCursor(css, SHELL),
        ...sweepSurfaces(css, SHELL),
      ]),
      rows,
    );

  it("holds as it is: the side layer typed twice, its row listing two", () => {
    expect(shell.split(SIDE).length - 1).toBe(2);
    expect(judgeShell(shell)).toEqual([]);
  });

  it("fails as NEW on a shadow, a blur and a fill typed by hand into the header card, each equal to what its role resolves to", () => {
    const seeds: [string, string, string][] = [
      ["shadow", "box-shadow: var(--surface-glass-chrome-shadow)", "box-shadow: 0 3px 12px var(--shadow)"],
      ["blur", "backdrop-filter: var(--surface-glass-chrome-blur)", "backdrop-filter: blur(18px)"],
      [
        "fill",
        "background: var(--surface-glass-chrome-fill)",
        "background: color-mix(in srgb, var(--bg-panel) 93%, transparent)",
      ],
    ];
    for (const [rule, read, typed] of seeds) {
      expect(shell.includes(read), read).toBe(true);
      const problems = judgeShell(shell.replace(read, typed));
      expect(problems, rule).toHaveLength(1);
      expect(problems[0], rule).toMatch(new RegExp("^NEW: " + SHELL.replace(/[()]/g, "\\$&") + " - " + rule + " "));
    }
  });

  it("fails as STALE when the side layer leaves the code while its row stays", () => {
    const healed = shell.replace(",\n    " + SIDE, "");
    expect(healed).not.toBe(shell);
    const problems = judgeShell(healed);
    expect(problems).toEqual([
      "STALE: " + SHELL + " - shadow " + JSON.stringify(SIDE) + " listed x2, found x1 (heal the inventory in the same change)",
    ]);
  });

  it("fails as NEW when the row is deleted while the code keeps the side layer", () => {
    const problems = judgeShell(
      shell,
      inventory.filter((r) => !(r.rule === "shadow" && r.value === SIDE)),
    );
    expect(problems).toEqual(["NEW: " + SHELL + " - shadow " + JSON.stringify(SIDE) + " x2"]);
  });
});

// The surface rows are the named exceptions and only ever shrink: a typed
// surface value cannot be absorbed by regenerating the inventory alone.
describe("judgeSurfaceNames", () => {
  it("fails a surface row that is not a named exception", () => {
    const row = { file: "src/x.module.css", rule: "shadow", value: "0 2px 6px var(--shadow)", count: 1 };
    expect(judgeSurfaceNames([row])).toEqual([
      'UNNAMED: src/x.module.css - shadow "0 2px 6px var(--shadow)" is not a named surface exception',
    ]);
  });

  it("passes the named exceptions and leaves the other rules' rows alone", () => {
    const rows = [
      { file: "src/app/(workspace)/layout.module.css", rule: "shadow", value: "16px 0 36px -18px var(--shadow)", count: 2 },
      { file: "src/x.module.css", rule: "font-size", value: "10px", count: 1 },
    ];
    expect(judgeSurfaceNames(rows)).toEqual([]);
  });

  it("holds over the committed inventory, every surface row carrying its note", () => {
    const rows = JSON.parse(readFileSync("scripts/wheelhouse-inventory.json", "utf8")) as Row[];
    const surface = rows.filter((r) => ["shadow", "blur", "fill"].includes(r.rule));
    expect(surface.length).toBeGreaterThan(0);
    expect(judgeSurfaceNames(rows)).toEqual([]);
    for (const r of surface) expect(r.exception, r.file + " " + r.value).toMatch(/^Surface exception: /);
  });
});

// Five ways the gate could be walked past. Each closure gets the arm
// that would have caught it.
describe("bypasses the gate closed", () => {
  it("sees a final declaration that omits its semicolon", () => {
    expect(rules(sweepStyles(".x { font-size: 10px }", "x.module.css"))).toEqual([
      "font-size",
    ]);
  });

  it("judges each motion literal even when a token sits beside it", () => {
    const out = sweepStyles(
      ".x { transition: opacity 0.5s var(--ease-panel); }",
      "x.module.css",
    );
    expect(rules(out)).toEqual(["duration"]);
    const inverse = sweepStyles(
      ".y { transition: opacity var(--dur-micro) cubic-bezier(0.9, 0, 0.1, 1); }",
      "y.module.css",
    );
    expect(rules(inverse)).toEqual(["easing"]);
  });

  it("catches a raw color hidden one hop away in a local custom property", () => {
    const out = sweepStyles(".x { --brand: #f00; color: var(--brand); }", "x.module.css");
    expect(rules(out)).toEqual(["color"]);
  });

  it("reads glyphs from rendered text, not from comments or code", () => {
    // Frozen non-violations: a comment naming the glyph it replaced.
    expect(sweepGlyphs("// replaced the ＋ glyph with PlusIcon", "x.tsx")).toEqual([]);
    expect(sweepGlyphs("const n = a + b;", "x.tsx")).toEqual([]);
    // Missed violations: the ASCII leftover the phase record names.
    expect(rules(sweepGlyphs("<button>+ Add filter</button>", "x.tsx"))).toEqual([
      "glyph",
    ]);
    expect(rules(sweepGlyphs("<span>▸</span>", "x.tsx"))).toEqual(["glyph"]);
  });

  it("judges an icon-only button by what it renders", () => {
    // An inline <svg> is an icon too.
    expect(
      rules(sweepNames("<button onClick={x}><svg aria-hidden /></button>", "x.tsx")),
    ).toEqual(["name"]);
    // Composed content may render the name: a residual, never a finding.
    expect(
      sweepNames("<button onClick={x}><CaretIcon />{label}</button>", "x.tsx"),
    ).toEqual([]);
  });
});

describe("sweepSpecimen", () => {
  const fed = (body: string) =>
    `/* wheelhouse:feed kit-css start */\n${body}\n/* wheelhouse:feed kit-css end */`;

  it("holds the authored page to the floor, the family and the glyph ban", () => {
    const page = [".a { font-size: 9.5px; }", ".b { border-radius: 7px; }", "<span>◇</span>"].join("\n");
    expect(rules(sweepSpecimen(page, "p.html")).sort()).toEqual([
      "specimen-floor",
      "specimen-glyph",
      "specimen-radius",
    ]);
  });

  it("lets the page show the radius family's own values, which its samples draw", () => {
    const page = ['<div class="box" style="border-radius:9px"></div>', ".b { border-radius: 20px; }"].join("\n");
    expect(sweepSpecimen(page, "p.html")).toEqual([]);
  });

  it("leaves the fed regions alone — they are the sources' business", () => {
    // A fed rule whose value is off-family is the shipped kit's own; the
    // freshness check owns that region. Blanking must run to the MATCHING
    // end marker, not to the first `*/` inside the fed CSS.
    const page = fed("/* --- Slider.module.css --- */\n.kit-slider-track { border-radius: 2px; }");
    expect(sweepSpecimen(page, "p.html")).toEqual([]);
  });

  it("exempts a line the page marks, for a rule it must print rather than follow", () => {
    const page = '<p>The rule bans ◇ and ▸</p> <!-- wheelhouse:allow — the page prints what it bans -->';
    expect(sweepSpecimen(page, "p.html")).toEqual([]);
  });

  it("does not exempt an unmarked line elsewhere", () => {
    const page = ["<!-- wheelhouse:allow — for the line above only -->", "<span>◇</span>"].join("\n");
    expect(rules(sweepSpecimen(page, "p.html"))).toEqual(["specimen-glyph"]);
  });
});

it("regenerates the current tree's style inventory byte for byte without writing it", () => {
  expect(inventoryText(toRows(sweepTree(process.cwd()))))
    .toBe(readFileSync("scripts/wheelhouse-inventory.json", "utf8"));
});
