// The class-pair sweep must find an element that takes classes from two
// CSS modules setting the same property at equal specificity, whether the
// classes meet in one className or through a component's className prop,
// and must leave alone the pairs file order cannot change: a higher
// specificity, the same value, classes that never stand together.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script, no declaration file on purpose.
import { overlaps, parseRules, specificity, sweep } from "../../scripts/check-class-pairs.mjs";

type Side = { file: string; cls: string; selector: string };
type Result = { kind: string; composed: boolean; a: Side; b: Side; props: { a: { prop: string }; same: boolean }[]; sites: string[] };

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A throwaway tree of source files, each path relative to its src/. */
function tree(files: Record<string, string>): string {
  root = mkdtempSync(path.join(tmpdir(), "class-pairs-"));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, "src", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

const results = (files: Record<string, string>): Result[] => sweep(tree(files)).results;
const brief = (r: Result) => [r.kind, r.a.selector, r.b.selector, r.props.map((p) => p.a.prop).join(" ")].join(" | ");

// A component that merges the class it is handed with its own, as the kit
// and the stage stack do.
const STACK = {
  "stack.module.css": ".stack { position: relative; color: red; }\n.stack:hover { opacity: 0.5; }\n",
  "Stack.tsx":
    'import s from "./stack.module.css";\n' +
    "export function Stack({ className }: { className?: string }) {\n" +
    "  return <div className={className ? `${s.stack} ${className}` : s.stack} />;\n" +
    "}\n",
};

describe("specificity", () => {
  it("counts as Selectors Level 4 does, :global() transparent and :where() free", () => {
    expect(specificity(".a")).toEqual([0, 1, 0]);
    expect(specificity(".a:hover::before")).toEqual([0, 2, 1]);
    expect(specificity('.a[data-x="1"] > span')).toEqual([0, 2, 1]);
    expect(specificity(":global(.dark) .a")).toEqual([0, 2, 0]);
    expect(specificity(".a:where(.b, .c)")).toEqual([0, 1, 0]);
    expect(specificity(".a:not(.b, #c)")).toEqual([1, 1, 0]);
  });
});

describe("overlapping properties", () => {
  it("counts a shorthand with its longhands and nothing it does not set", () => {
    expect(overlaps("margin", "margin-top")).toBe(true);
    expect(overlaps("inset", "left")).toBe(true);
    expect(overlaps("gap", "row-gap")).toBe(true);
    expect(overlaps("border", "border-radius")).toBe(false);
    expect(overlaps("flex", "flex-direction")).toBe(false);
    expect(overlaps("overflow", "overflow-wrap")).toBe(false);
  });
});

describe("parseRules", () => {
  it("reads rules inside at-rules with their context, and skips keyframes", () => {
    const rules = parseRules("/* .x { a: b } */\n@media (max-width: 700px) {\n  .a { color: red }\n}\n@keyframes k { from { opacity: 0 } }\n.b, .c:hover { gap: 4px !important; }");
    expect(rules.map((r: { selectors: string[]; context: string }) => [r.selectors, r.context])).toEqual([
      [[".a"], "@media (max-width: 700px)"],
      [[".b", ".c:hover"], ""],
    ]);
    expect(rules[1].decls).toEqual([{ prop: "gap", value: "4px", important: true }]);
  });
});

describe("the sweep", () => {
  it("finds a class handed to a component that merges it, setting what the component's own class sets", () => {
    const found = results({
      ...STACK,
      "place.module.css": ".anchor { position: absolute; top: 0; }\n",
      "Use.tsx": 'import p from "./place.module.css";\nimport { Stack } from "./Stack";\nexport function Use() { return <Stack className={p.anchor} />; }\n',
    });
    expect(found.map(brief)).toEqual(["FINDING | .anchor | .stack | position"]);
    expect(found[0].sites).toEqual(["src/Use.tsx:3 <Stack className> -> src/Stack.tsx:3 <div>"]);
  });

  it("finds two modules' classes written into one element, and follows a prop passed on through a rest spread", () => {
    const found = results({
      ...STACK,
      "a.module.css": ".x { display: flex; }\n",
      "b.module.css": ".y { display: grid; }\n.z { color: blue; }\n",
      "Wrap.tsx": 'import { Stack } from "./Stack";\nexport function Wrap({ title, ...rest }: { title: string; className?: string }) {\n  return <Stack {...rest} />;\n}\n',
      "Use.tsx":
        'import a from "./a.module.css";\nimport b from "./b.module.css";\nimport { Wrap } from "./Wrap";\n' +
        "export function Use() {\n  return <>\n    <p className={`${a.x} ${b.y}`} />\n    <Wrap title=\"t\" className={b.z} />\n  </>;\n}\n",
    });
    expect(found.map(brief).sort()).toEqual(["FINDING | .x | .y | display", "FINDING | .z | .stack | color"].sort());
  });

  it("calls a pair conditional when the two rules apply together only in some states", () => {
    const found = results({
      ...STACK,
      "place.module.css": ".pane .anchor { opacity: 1; }\n",
      "Use.tsx": 'import p from "./place.module.css";\nimport { Stack } from "./Stack";\nexport function Use() { return <Stack className={p.anchor} />; }\n',
    });
    expect(found.map(brief)).toEqual(["CONDITIONAL | .pane .anchor | .stack:hover | opacity"]);
  });

  it("leaves alone what file order cannot change: the same value, a higher specificity, classes in separate branches", () => {
    const found = results({
      ...STACK,
      "a.module.css": ".x { position: relative; }\n.w { color: green; }\n",
      "b.module.css": ".y.on { color: blue; }\n.v { flex: none; }\n.k { color: purple; }\n",
      "c.module.css": ".u { flex-shrink: 0; }\n",
      "Use.tsx":
        'import a from "./a.module.css";\nimport b from "./b.module.css";\nimport c from "./c.module.css";\nimport { Stack } from "./Stack";\n' +
        "export function Use({ on }: { on: boolean }) {\n  return <>\n    <Stack className={a.x} />\n    <i className={`${a.w} ${b.y} ${b.on}`} />\n" +
        "    <b className={on ? a.w : b.k} />\n    <u className={[b.v, c.u].join(\" \")} />\n  </>;\n}\n",
    });
    expect(found.map(brief).sort()).toEqual(["SAME | .x | .stack | position", "SAME | .v | .u | flex"].sort());
  });

  it("reads the element an arrow function returns without braces, as it reads one in parentheses or a block", () => {
    const found = results({
      ...STACK,
      "a.module.css": ".x { position: absolute; }\n",
      "b.module.css": ".y { position: relative; }\n",
      "Bare.tsx": 'import a from "./a.module.css";\nimport b from "./b.module.css";\nexport const Bare = () => <div className={`${a.x} ${b.y}`} />;\n',
      "Paren.tsx": 'import a from "./a.module.css";\nimport b from "./b.module.css";\nexport const Paren = () => (<span className={`${a.x} ${b.y}`} />);\n',
      "Block.tsx": 'import a from "./a.module.css";\nimport b from "./b.module.css";\nexport const Block = () => { return <i className={`${a.x} ${b.y}`} />; };\n',
      "Place.tsx": 'import a from "./a.module.css";\nimport { Stack } from "./Stack";\nexport const Place = () => <Stack className={a.x} />;\n',
    });
    expect(found.map(brief).sort()).toEqual(["FINDING | .x | .stack | position", "FINDING | .x | .y | position"]);
    expect(found.find((r) => r.b.cls === "y")?.sites).toEqual(["src/Bare.tsx:3 <div>", "src/Block.tsx:3 <i>", "src/Paren.tsx:3 <span>"]);
    expect(found.find((r) => r.b.cls === "stack")?.sites).toEqual(["src/Place.tsx:3 <Stack className> -> src/Stack.tsx:3 <div>"]);
  });

  it("compares the classes two props put on one element, handed in directly or passed on by a wrapper", () => {
    const found = results({
      "box.module.css": ".box { color: red; }\n",
      "Box.tsx":
        'import s from "./box.module.css";\n' +
        "export function Box({ first, second }: { first?: string; second?: string }) {\n" +
        '  return <div className={[s.box, first, second].join(" ")} />;\n' +
        "}\n",
      "a.module.css": ".x { position: absolute; }\n",
      "b.module.css": ".y { position: relative; }\n",
      "Wrap.tsx":
        'import b from "./b.module.css";\nimport { Box } from "./Box";\n' +
        "export function Wrap({ className }: { className?: string }) {\n" +
        "  return <Box first={className} second={b.y} />;\n" +
        "}\n",
      "Use.tsx":
        'import a from "./a.module.css";\nimport b from "./b.module.css";\nimport { Box } from "./Box";\nimport { Wrap } from "./Wrap";\n' +
        "export function Use() {\n  return <>\n    <Box first={a.x} second={b.y} />\n    <Wrap className={a.x} />\n  </>;\n}\n",
    });
    expect(found.map(brief)).toEqual(["FINDING | .x | .y | position"]);
    expect(found[0].sites).toEqual([
      "src/Use.tsx:7 <Box first second> -> src/Box.tsx:3 <div>",
      "src/Use.tsx:8 <Wrap className> -> src/Wrap.tsx:4 <Box> -> src/Box.tsx:3 <div>",
    ]);
  });

  it("follows a class that composes another module's class", () => {
    const found = results({
      "base.module.css": ".section { padding: 12px; }\n",
      "own.module.css": '.box { composes: section from "./base.module.css"; padding-top: 4px; }\n',
      "Use.tsx": 'import o from "./own.module.css";\nexport function Use() { return <div className={o.box} />; }\n',
    });
    expect(found.map((r) => [r.kind, r.composed])).toEqual([["FINDING", true]]);
  });
});
