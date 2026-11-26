import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS modules built on the source collector, no declaration file on purpose.
import { collect, judge, keyOf, monoUses, pending } from "../scripts/mono-uses.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS module, no declaration file on purpose.
import { collect as collectPlain } from "../scripts/source-collector.mjs";

/**
 * The mono boundary. Mono (DM Mono in the workspace, IBM Plex Mono on
 * published maps) is for code and data written as code: SQL, a dataset
 * written the way SQL writes it, a table's structure and raw data, engine
 * errors word for word, code to copy, identifiers, addresses and paths,
 * and the fields that create a dataset's SQL name. Names, people, counts,
 * sizes, times, kinds and states read in the reading face.
 *
 * The source collector reads the whole tree (stylesheets, the elements the
 * components draw with the classes they can wear, styles set in code) and
 * the check holds these against one list, mono-boundary.allowed.json:
 *
 *   - declarations: every family, `font` shorthand or custom property that
 *     resolves to a mono face, in a stylesheet or set in code, and any other
 *     line of TypeScript that names one (the font loaders);
 *   - elements: every element that wears a listed mono style and the text
 *     that inherits it, so a listed style put on a new element is growth;
 *   - kinds: each mono row's kind, held against what it reaches. The kinds
 *     of code and data are sql, sql-name, structure, engine-error, code,
 *     identifier, address and new-dataset-name; face is the faces' own
 *     definitions; keeps is a use the rule does not name, which keeps its
 *     face; to-reading-face and unused are what the work still moves. A
 *     row's `split` gives its other parts their kind, by identity;
 *   - code marks: a code, pre, kbd or samp element that nothing gives a
 *     family falls back to the browser's own monospace, at its own size;
 *   - digits: the numbers set in digits of one width, which must keep them;
 *   - unread: an element whose classes the collector cannot read, where a
 *     module they can come from sets mono or digits, named with what its
 *     classes are.
 *
 * Everything is compared both ways: a use, an element, inheriting text, a
 * code mark or a number that no row names fails as growth, and a row whose
 * use, element or text is gone fails as stale.
 */

type Row = {
  layer: "mono" | "digits" | "mark" | "unread";
  id: string;
  kind?: string;
  note?: string;
  unseen?: string;
  rule?: string;
  in?: string;
  split?: Record<string, string>;
  elements?: string[];
  inherits?: string[];
};
type Finding = { check: string; key: string; message: string };
type Use = { layer: string; id: string; origin: string; elements: Map<string, unknown>; inherits: Map<string, unknown> };
type Uses = { uses: Map<string, Use>; marks: Map<string, { id: string }>; unread: Map<string, unknown>; context: unknown };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ALLOWED: Row[] = JSON.parse(readFileSync(path.join(HERE, "mono-boundary.allowed.json"), "utf8"));

/**
 * The parts of the list the work still moves: mono parts listed as moving
 * to the reading face, rules no element wears, and code marks still in the
 * browser's monospace. Each move drops its parts from the list and lowers
 * this number with them; a new use that the rule moves is not added here.
 * None is left: the list holds only uses that keep their face.
 */
const PENDING = 0;

const model = collect({ root: ROOT });
const found: Uses = monoUses(model);
const findings: Finding[] = judge(found, { allowed: ALLOWED });
const failing = (...checks: string[]) => findings.filter((f) => checks.includes(f.check)).map((f) => f.message);

describe("the mono boundary", () => {
  it("reads the tree (the check is not vacuous)", () => {
    expect(model.stats.stylesheets).toBeGreaterThan(150);
    expect(model.stats.elements).toBeGreaterThan(5000);
    // Floors near 85% of what the tree holds, so a collector that stops
    // reading part of it fails here before the list can agree with it.
    const uses = [...found.uses.values()];
    const mono = uses.filter((u) => u.layer === "mono");
    const digits = uses.filter((u) => u.layer === "digits");
    expect(mono.length).toBeGreaterThanOrEqual(92);
    expect(mono.reduce((n, u) => n + u.elements.size, 0)).toBeGreaterThanOrEqual(107);
    expect(mono.reduce((n, u) => n + u.inherits.size, 0)).toBeGreaterThanOrEqual(28);
    expect(mono.filter((u) => u.origin === "code").length).toBeGreaterThanOrEqual(2);
    expect(digits.length).toBeGreaterThanOrEqual(75);
    expect(digits.reduce((n, u) => n + u.elements.size + u.inherits.size, 0)).toBeGreaterThanOrEqual(247);
    // Representative survivors of distinct roads: a style set in code, a
    // stylesheet rule, a font loader, a code mark, digits of one width.
    expect(found.uses.has('mono :: src/components/SqlEditor.tsx :: editorTheme > ".cm-scroller" > fontFamily')).toBe(true);
    expect(found.uses.has("mono :: src/components/ResultGrid.module.css :: .grid")).toBe(true);
    expect(found.uses.has("mono :: src/app/document.tsx :: const dmMono = DM_Mono({")).toBe(true);
    expect(found.marks.has("src/components/sql/ResultsPane.tsx :: ResultsPane <code> {savedAs}")).toBe(true);
    expect(found.uses.has("digits :: src/components/gallery.module.css :: .numCell")).toBe(true);
    expect(ALLOWED.length).toBeGreaterThan(150);
  });

  it("every mono declaration is listed (declarations)", () => {
    expect(failing("declaration")).toEqual([]);
  });

  it("every element wearing a listed mono style, and all text inheriting it, is listed (reuse is growth)", () => {
    expect(failing("element", "inheritance")).toEqual([]);
  });

  it("each mono row still has its kind", () => {
    expect(failing("kind")).toEqual([]);
  });

  it("no row outlives its use, and no use is listed twice", () => {
    expect(failing("list")).toEqual([]);
  });

  it("no code mark falls back to the browser's own monospace unless listed", () => {
    expect(failing("mark")).toEqual([]);
  });

  it("every number set in digits of one width keeps them (the numbers inventory)", () => {
    expect(failing("digits")).toEqual([]);
  });

  it("names every element whose classes it cannot read where mono or digits could reach it (unread)", () => {
    expect(failing("unread")).toEqual([]);
  });

  it("counts the parts the work still moves", () => {
    expect(pending(ALLOWED)).toBe(PENDING);
  });

  it("reads every font style set in code (none is passed as unread)", () => {
    const unread = model.unresolved.filter((u: { kind: string; text: string }) => u.kind === "style" && /^font/.test(u.text));
    expect(unread).toEqual([]);
  });
});

/* ---- seeded trees ---- */

const CSS = "src/fixture/panel.module.css";
const TSX = "src/fixture/Panel.tsx";
const GLOBALS = "src/fixture/globals.css";
const BASE_CSS = `
.sql { font-family: var(--font-mono); }
.grid { font-family: var(--font-mono); }
.grid th { color: var(--fg-muted); }
.rowName { font-family: var(--font-mono); }
.qualifier { color: var(--fg-muted); }
.nameField { font-family: var(--font-mono); }
.note code { font-family: var(--font-mono); font-size: 1em; }
.keys kbd { font-family: var(--font-ui); }
.count { font-variant-numeric: tabular-nums; }
.facts { font-variant-numeric: tabular-nums; }
.title { font-weight: 600; }
`;
const BASE_BODY = `
      <pre className={styles.sql}>{query.sql}</pre>
      <table className={styles.grid}><tbody><tr><th>{column.name}</th><td>{cell}</td></tr></tbody></table>
      <span className={styles.rowName}><i className={styles.qualifier}>{owner}.</i>{t.name}</span>
      <input className={styles.nameField} aria-label="Table name" />
      <p className={styles.note}>Set <code>DEZFIL_API_TOKEN</code> first.</p>
      <p className={styles.keys}>Press <kbd>/</kbd> to search.</p>
      <span className={styles.count}>{formatCount(t.rowCount)} rows</span>
      <ul className={styles.facts}><li>{formatBytes(t.sizeBytes)}</li></ul>
      <h2 className={styles.title}>{table.name}</h2>`;

/** A seeded tree: `top` is written at the top of the component's module,
 * `head` in its body before it draws. */
type Seed = { css?: string; body?: string; extra?: string; baseCss?: string; top?: string; head?: string };
function tree({ css = "", body = BASE_BODY, extra = "", baseCss = BASE_CSS, top = "", head = "" }: Seed = {}): Map<string, string> {
  const tsx = `import styles from "./panel.module.css";${top}
export function Panel({ query, column, cell, owner, t, table, busy }: Record<string, any>) {${head}
  return (
    <section>${body}${extra}
    </section>
  );
}
`;
  return new Map([
    [GLOBALS, `:root { --font-mono: var(--font-dm-mono), "SF Mono", monospace; }\n`],
    [CSS, baseCss + css],
    [TSX, tsx],
  ]);
}
const usesOf = (sources: Map<string, string>): Uses => monoUses(collect({ root: "/fixture", sources }));

/** Rows for every use and code mark of a tree, as a list written for it
 * would hold them. */
function rowsFor(uses: Uses, kinds: Record<string, string>): Row[] {
  const rows: Row[] = [...uses.uses.values()].map((u) => ({
    layer: u.layer as Row["layer"],
    id: u.id,
    ...(u.layer === "mono" ? { kind: kinds[u.layer + " :: " + u.id] } : {}),
    elements: [...u.elements.keys()],
    inherits: [...u.inherits.keys()],
  }));
  for (const id of uses.marks.keys()) rows.push({ layer: "mark", id, kind: kinds["mark :: " + id] ?? "to-mono", note: "a code mark" });
  return rows;
}

const KIND_OF = {
  [`mono :: ${GLOBALS} :: :root`]: "face",
  [`mono :: ${CSS} :: .sql`]: "sql",
  [`mono :: ${CSS} :: .grid`]: "structure",
  [`mono :: ${CSS} :: .rowName`]: "sql-name",
  [`mono :: ${CSS} :: .nameField`]: "new-dataset-name",
  [`mono :: ${CSS} :: .note code`]: "identifier",
};
const BASE = rowsFor(usesOf(tree()), KIND_OF);
const judged = (seed: Seed, lists: { allowed?: Row[] } = { allowed: BASE }): Finding[] => judge(usesOf(tree(seed)), lists);
const checks = (f: Finding[]) => [...new Set(f.map((x) => x.check))].sort();
const message = (f: Finding[], check: string) => f.filter((x) => x.check === check).map((x) => x.message).join("\n");

describe("the mono boundary on seeded trees", () => {
  /* What passes: code and raw data in mono, a face's own definition, a
   * SQL name drawn with its qualifier, a field that names a new dataset,
   * a code mark a mono rule reaches, a key in the reading face, numbers
   * that keep digits of one width, their own or inherited. */
  it("the seeded tree passes with its list", () => {
    expect(BASE.filter((r) => r.layer === "mono").map((r) => keyOf(r)).sort()).toEqual(Object.keys(KIND_OF).sort());
    expect(usesOf(tree()).marks.size).toBe(0);
    expect(judged({})).toEqual([]);
  });

  it("lists text inside a mono rule as inheriting it, and a number inside a list of one-width digits as keeping them", () => {
    const grid = BASE.find((r) => r.id === `${CSS} :: .grid`);
    expect(grid?.inherits).toEqual([`${TSX} :: Panel <th> {column.name}`, `${TSX} :: Panel <td> {cell}`]);
    const facts = BASE.find((r) => r.id === `${CSS} :: .facts`);
    expect(facts?.inherits).toEqual([`${TSX} :: Panel <li> {formatBytes(t.sizeBytes)}`]);
  });

  /* The four the boundary exists for. */
  const NEW_STYLES: [string, Seed, string][] = [
    ["the mono token", { css: ".label { font-family: var(--font-mono); }", extra: `\n      <h3 className={styles.label}>Parcels</h3>` }, `${CSS} :: .label`],
    ["a loaded face used directly", { css: ".label { font-family: var(--font-dm-mono); }", extra: `\n      <h3 className={styles.label}>Parcels</h3>` }, `${CSS} :: .label`],
    ["a written stack", { css: '.label { font-family: "IBM Plex Mono", monospace; }', extra: `\n      <h3 className={styles.label}>Parcels</h3>` }, `${CSS} :: .label`],
    ["the font shorthand", { css: ".label { font: 600 13px/1.4 var(--font-mono); }", extra: `\n      <h3 className={styles.label}>Parcels</h3>` }, `${CSS} :: .label`],
    ["a custom property defined from the token", { css: ".panel { --code: var(--font-mono); }\n.label { font-family: var(--code); }", extra: `\n      <h3 className={styles.label}>Parcels</h3>` }, `${CSS} :: .label`],
    ["an inline style", { extra: `\n      <h3 style={{ fontFamily: "var(--font-mono)" }}>Parcels</h3>` }, `${TSX} :: Panel <h3> "Parcels" style > fontFamily`],
    ["a style object held in a constant", { top: `\nconst face = { fontFamily: "var(--font-mono)" };`, extra: `\n      <h3 style={face}>Parcels</h3>` }, `${TSX} :: face > fontFamily`],
  ];
  it.each(NEW_STYLES)("fails on a new mono style that isn't listed: %s", (_name, seed, id) => {
    const f = judged(seed);
    expect(checks(f)).toEqual(["declaration"]);
    expect(f.map((x) => x.key)).toContain(`mono :: ${id}`);
    expect(message(f, "declaration")).toContain('"Parcels"');
  });

  it("fails on a listed mono style reused on a dataset's name shown as a name, with no new style and no change to the list", () => {
    const f = judged({ extra: `\n      <h3 className={styles.rowName}>{table.name}</h3>` });
    expect(checks(f)).toEqual(["element", "kind"]);
    expect(message(f, "element")).toContain(`${TSX} :: Panel <h3.rowName> {table.name} wears it and is not listed`);
    expect(message(f, "kind")).toContain("not sql-name: ");
    expect(message(f, "kind")).toContain("shows a name read as a name: {table.name}");
  });

  it("still fails on that reuse once the list names the new element", () => {
    const seed = { extra: `\n      <h3 className={styles.rowName}>{table.name}</h3>` };
    const f = judged(seed, { allowed: rowsFor(usesOf(tree(seed)), KIND_OF) });
    expect(checks(f)).toEqual(["kind"]);
  });

  it("fails on a dataset's name that inherits a listed mono style from a parent", () => {
    const f = judged({ body: BASE_BODY.replace("<td>{cell}</td>", "<td>{cell}</td><td><b>{table.name}</b></td>") });
    expect(checks(f)).toEqual(["inheritance", "kind"]);
    expect(message(f, "inheritance")).toContain(`${TSX} :: Panel <b> {table.name} inherits it and is not listed`);
    expect(message(f, "kind")).toContain("not structure: ");
  });

  it("fails on a code mark in the browser's monospace", () => {
    const f = judged({ extra: `\n      <p>Run <code>npm test</code> first.</p>` });
    expect(checks(f)).toEqual(["mark"]);
    expect(message(f, "mark")).toContain(`${TSX} :: Panel <code> "npm test" has no family of its own, so the browser sets its own monospace on it`);
  });

  it("fails on a code mark inside a mono block, which the block's face does not reach", () => {
    const f = judged({ extra: `\n      <div className={styles.sql}><code>{query.sql}</code></div>` });
    expect(checks(f)).toContain("mark");
    expect(message(f, "mark")).toContain(`${TSX} :: Panel <code> {query.sql} has no family of its own`);
  });

  /* A rule under a media query a screen never matches sets nothing on a
   * screen: no face on a code mark, no mono face, no digits. */
  it("fails on a code mark whose only family is set for print", () => {
    const f = judged({ css: "@media print { .printCode { font-family: var(--font-ui); } }", extra: `\n      <p>Run <code className={styles.printCode}>npm test</code> first.</p>` });
    expect(checks(f)).toEqual(["mark"]);
    expect(message(f, "mark")).toContain(`${TSX} :: Panel <code.printCode> "npm test" has no family of its own`);
  });

  const MEDIA: [string, number][] = [
    ["@media print", 0],
    ["@media only print", 0],
    ["@media speech", 0],
    ["@media not screen", 0],
    ["@media print and (orientation: landscape)", 0],
    ["@media print, screen", 1],
    ["@media not print", 1],
    ["@media (max-width: 600px)", 1],
    ["@media screen and (max-width: 600px)", 1],
    ["@media not all and (monochrome)", 1],
  ];
  it.each(MEDIA)("reads a mono face and digits set under %s as reaching %i element(s) on a screen", (media, n) => {
    const seed = { css: `${media} { .label { font-family: var(--font-mono); } .size { font-variant-numeric: tabular-nums; } }`, extra: `\n      <h3 className={styles.label}>Parcels</h3><span className={styles.size}>{formatBytes(t.sizeBytes)}</span>` };
    const uses = usesOf(tree(seed)).uses;
    expect(uses.get(`mono :: ${CSS} :: ${media} { .label }`)?.elements.size).toBe(n);
    expect(uses.get(`digits :: ${CSS} :: ${media} { .size }`)?.elements.size).toBe(n);
  });

  it("fails on a list's numbers without digits of one width: the listed rule loses them", () => {
    const f = judged({ baseCss: BASE_CSS.replace(".count { font-variant-numeric: tabular-nums; }", ".count { color: var(--fg-muted); }") });
    expect(f.map((x) => x.message)).toEqual([`digits :: ${CSS} :: .count: the allowed row outlives its use`]);
  });

  it("fails on a list's numbers without digits of one width: the count moves to a class without them", () => {
    const f = judged({ body: BASE_BODY.replace("<span className={styles.count}>", "<span className={styles.title}>") });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain(`listed ${TSX} :: Panel <span.count> "rows" {formatCount(t.rowCount)} no longer wears digits of one width from it`);
  });

  it("fails on a list's numbers without digits of one width: a stronger rule takes them away", () => {
    const f = judged({ css: "span.count { font-variant-numeric: proportional-nums; }" });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain("no longer wears digits of one width from it");
  });

  it("fails on a list's numbers without digits of one width: an inherited number is set back", () => {
    const f = judged({ css: ".facts li { font-variant-numeric: normal; }" });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain(`listed ${TSX} :: Panel <li> {formatBytes(t.sizeBytes)} no longer inherits digits of one width from it`);
  });

  /* A style set in code outranks every rule, and the font shorthand sets
   * the numeric variants back to normal (and the feature settings with
   * them), so either takes digits of one width away. */
  const SPAN_COUNT = "<span className={styles.count}>";
  const TAKEN_AWAY: [string, Seed, string][] = [
    ["an inline numeric style on the number", { body: BASE_BODY.replace(SPAN_COUNT, `<span className={styles.count} style={{ fontVariantNumeric: "proportional-nums" }}>`) }, "wears"],
    ["an inline font shorthand on the number", { body: BASE_BODY.replace(SPAN_COUNT, `<span className={styles.count} style={{ font: "400 13px var(--font-ui)" }}>`) }, "wears"],
    ["an inline font shorthand on an inherited number", { body: BASE_BODY.replace("<li>", `<li style={{ font: "400 13px var(--font-ui)" }}>`) }, "inherits"],
    ["a later font shorthand on the same class", { css: ".count { font: 400 13px var(--font-ui); }" }, "wears"],
    ["a stronger rule's font shorthand, even one that inherits", { css: "span.count { font: inherit; }" }, "wears"],
    ["a font shorthand on an inherited number", { css: ".facts li { font: 400 13px var(--font-ui); }" }, "inherits"],
  ];
  it.each(TAKEN_AWAY)("fails on a list's numbers without digits of one width: %s", (_name, seed, verb) => {
    const f = judged(seed);
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain(`no longer ${verb} digits of one width from it`);
  });

  /* The feature settings apply over the numeric variants whatever rule
   * sets which, so turning the tnum feature off takes digits of one width
   * away even from a weaker rule, and the strongest feature setting
   * decides. */
  const FEATURE_OFF: [string, Seed, string][] = [
    ["a weaker rule that turns the tnum feature off", { css: 'span { font-feature-settings: "tnum" 0; }' }, "wears"],
    ["the tnum feature turned off on an inherited number", { css: '.facts li { font-feature-settings: "tnum" off; }' }, "inherits"],
    ["an inline style that turns the tnum feature off", { body: BASE_BODY.replace(SPAN_COUNT, `<span className={styles.count} style={{ fontFeatureSettings: '"tnum" 0' }}>`) }, "wears"],
  ];
  it.each(FEATURE_OFF)("fails on a list's numbers without digits of one width: %s", (_name, seed, verb) => {
    const f = judged(seed);
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain(`no longer ${verb} digits of one width from it`);
  });

  it("fails on numbers set in digits of one width in code when a rule turns the tnum feature off", () => {
    const seed = { extra: `\n      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCount(t.rowCount)}</span>` };
    const rows = rowsFor(usesOf(tree(seed)), KIND_OF);
    expect(judge(usesOf(tree(seed)), { allowed: rows })).toEqual([]);
    const f = judge(usesOf(tree({ ...seed, css: 'span { font-feature-settings: "tnum" 0; }' })), { allowed: rows });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain("no longer wears digits of one width from it");
  });

  it("keeps a list's digits of one width when a stronger feature setting gives the tnum feature back", () => {
    expect(judged({ css: 'span { font-feature-settings: "tnum" 0; }\nspan.count { font-feature-settings: "liga"; }' })).toEqual([]);
  });

  it("fails on numbers set in digits of one width by the feature settings that a later font shorthand sets back", () => {
    const seed = { css: '.fig { font-feature-settings: "tnum"; }', extra: `\n      <span className={styles.fig}>{formatCount(t.rowCount)}</span>` };
    const rows = rowsFor(usesOf(tree(seed)), KIND_OF);
    expect(judge(usesOf(tree(seed)), { allowed: rows })).toEqual([]);
    const f = judge(usesOf(tree({ ...seed, css: seed.css + "\n.fig { font: 400 13px var(--font-ui); }" })), { allowed: rows });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain("no longer wears digits of one width from it");
  });

  it("fails on new digits of one width that the inventory does not list", () => {
    const f = judged({ css: ".size { font-variant-numeric: tabular-nums; }", extra: `\n      <span className={styles.size}>{formatBytes(t.sizeBytes)}</span>` });
    expect(checks(f)).toEqual(["digits"]);
    expect(message(f, "digits")).toContain("not listed");
  });

  /* Kinds held against what a use reaches. */
  const MISLABELS: [string, string, string, string, string][] = [
    ["a name made by a tool, listed as a field that names a new dataset", ".made { font-family: var(--font-mono); }", `<b className={styles.made}>{result.table}</b>`, "new-dataset-name", "is not a field"],
    ["a field listed as a SQL name", ".out { font-family: var(--font-mono); }", `<input className={styles.out} aria-label="Output" />`, "sql-name", "is a field"],
    ["a count listed as an identifier", ".rows { font-family: var(--font-mono); }", `<span className={styles.rows}>{formatCount(t.rowCount)}</span>`, "identifier", "shows a count, a size or a time"],
    ["a geometry kind listed as structure", ".kindCell { font-family: var(--font-mono); }", `<span className={styles.kindCell}>{t.geometryType}</span>`, "structure", "shows a geometry kind"],
    ["a sentence listed as an address", ".addr { font-family: var(--font-mono); }", `<p className={styles.addr}>Paste the address of your tile server.</p>`, "address", "shows a sentence"],
    ["a number field listed as an identifier", ".limit { font-family: var(--font-mono); }", `<input className={styles.limit} type="number" />`, "identifier", "is a number field"],
    ["a rule that sets a family, listed as a face", ".face { font-family: var(--font-mono); }", `<span className={styles.face}>{query.id}</span>`, "face", "sets a family on an element"],
    ["a use kept as it is, with no note", ".kept { font-family: var(--font-mono); }", `<span className={styles.kept}>{query.id}</span>`, "keeps", "must say what it is"],
    ["a use the rule moves, with no note", ".moving { font-family: var(--font-mono); }", `<span className={styles.moving}>{query.id}</span>`, "to-reading-face", "must say what it is"],
    ["a rule an element wears, listed as unused", ".gone { font-family: var(--font-mono); }", `<span className={styles.gone}>{query.id}</span>`, "unused", "reaches elements"],
  ];
  it.each(MISLABELS)("fails on %s", (_name, css, body, kind, why) => {
    const seed = { css, extra: `\n      ${body}` };
    const uses = usesOf(tree(seed));
    const added = [...uses.uses.keys()].filter((k) => k.startsWith("mono :: ") && !(k in KIND_OF));
    expect(added).toHaveLength(1);
    const f = judge(uses, { allowed: rowsFor(uses, { ...KIND_OF, [added[0]]: kind }) });
    expect(checks(f)).toEqual(["kind"]);
    expect(f[0].message).toContain(`not ${kind}: `);
    expect(f[0].message).toContain(why);
  });

  it("passes a part of a row given its own kind, and fails a split that names what the use does not reach", () => {
    const seed = { css: ".facts2 { font-family: var(--font-mono); }", extra: `\n      <dl><dd className={styles.facts2}>{query.id}</dd><dd className={styles.facts2}>{formatCount(t.rowCount)}</dd></dl>` };
    const uses = usesOf(tree(seed));
    const key = `mono :: ${CSS} :: .facts2`;
    const rows = rowsFor(uses, { ...KIND_OF, [key]: "identifier" });
    const row = rows.find((r) => keyOf(r) === key) as Row;
    expect(checks(judge(uses, { allowed: rows }))).toEqual(["kind"]);
    row.note = "Its count moves to the reading face.";
    row.split = { [`${TSX} :: Panel <dd.facts2> {formatCount(t.rowCount)}`]: "to-reading-face" };
    expect(judge(uses, { allowed: rows })).toEqual([]);
    row.split = { [`${TSX} :: Panel <dd.facts2> {t.rowCount}`]: "to-reading-face" };
    expect(message(judge(uses, { allowed: rows }), "kind")).toContain("split names");
  });

  /* Code marks a list names. */
  it("fails on a listed code mark that gets a family of its own while its row stays", () => {
    const seed = { extra: `\n      <p>Run <code>npm test</code> first.</p>` };
    const rows = rowsFor(usesOf(tree(seed)), KIND_OF);
    expect(judge(usesOf(tree(seed)), { allowed: rows })).toEqual([]);
    const f = judged({ ...seed, css: "p code { font-family: var(--font-mono); }" }, { allowed: rows });
    expect(message(f, "mark")).toContain("has a family of its own now; drop its row");
  });

  /* Markup held in a list the collector does not follow, shown in a
   * paragraph inside the note. */
  const HELD = `\nconst notes = [<code key="a">{"query_result"}</code>];`;
  const SHOWN_IN = `${TSX} :: Panel <p>`;
  const shownIn = (wrapper: string) => ({ top: HELD, extra: `\n      <div${wrapper}><p>{notes}</p></div>` });
  const HELD_SEED = shownIn(" className={styles.note}");
  /** The seeded tree's rows, its held code mark listed as reached. */
  const reachedRows = (seed: Seed, mark: Partial<Row>): Row[] => {
    const uses = usesOf(tree(seed));
    const [id] = [...uses.marks.keys()];
    const others = rowsFor(uses, KIND_OF).filter((r) => r.layer !== "mark");
    return [...others, { layer: "mark", id, kind: "reached", note: "Held in a list the collector does not follow.", ...mark }];
  };
  it("holds a code mark reached by a rule the collector cannot see to that rule", () => {
    const uses = usesOf(tree(HELD_SEED));
    expect(uses.marks.size).toBe(1);
    const reached = (rule: string): Row[] => reachedRows(HELD_SEED, { rule, in: SHOWN_IN });
    expect(judge(uses, { allowed: reached(`${CSS} :: .note code`) })).toEqual([]);
    expect(message(judge(uses, { allowed: reached(`${CSS} :: .keys kbd`) }), "mark")).toContain("does not ask for <code>");
    expect(message(judge(uses, { allowed: reached(`${CSS} :: .missing code`) }), "mark")).toContain("rule names no rule");
  });

  /* The rule must reach the mark where the list says it is shown, and keep
   * its face there in the cascade. */
  const UNREACHED: [string, Seed, Partial<Row>, string][] = [
    ["the element it is shown in loses the class the rule asks for", shownIn(""), { in: SHOWN_IN }, `does not reach it in ${SHOWN_IN}`],
    ["a stronger rule sets another face where it is shown", { ...HELD_SEED, css: ".note p code { font-family: var(--font-ui); }" }, { in: SHOWN_IN }, "a stronger rule takes its face off it"],
    ["the element it is shown in is gone", HELD_SEED, { in: `${TSX} :: Panel <aside>` }, `in names no element: ${TSX} :: Panel <aside>`],
    ["the row does not say where it is shown", HELD_SEED, {}, "must name the element it is shown in (in)"],
  ];
  it.each(UNREACHED)("fails on a reached code mark when %s", (_name, seed, mark, why) => {
    const rows = reachedRows(HELD_SEED, { rule: `${CSS} :: .note code`, ...mark });
    expect(message(judge(usesOf(tree(seed)), { allowed: rows }), "mark")).toContain(why);
  });

  /* Classes it cannot read, where a module they can come from sets mono or
   * digits: named in the list, both ways. */
  const UNREAD_SITE = `${TSX} :: Panel <h3> {table.name} :: styles[table.name]`;
  const UNREAD_SEED = { extra: `\n      <h3 className={styles[table.name]}>{table.name}</h3>` };
  it("fails on an element whose classes it cannot read where their module sets mono or digits, until the list names it", () => {
    const f = judged(UNREAD_SEED);
    expect(checks(f)).toEqual(["unread"]);
    expect(message(f, "unread")).toContain(`unread :: ${UNREAD_SITE}: its classes cannot be read, and ${CSS} sets mono or digits of one width`);
    const rows: Row[] = [...BASE, { layer: "unread", id: UNREAD_SITE, note: "A heading's class, picked at run time." }];
    expect(judged(UNREAD_SEED, { allowed: rows })).toEqual([]);
    expect(message(judged(UNREAD_SEED, { allowed: [...BASE, { layer: "unread", id: UNREAD_SITE }] }), "unread")).toContain("must say what they are (note)");
    expect(message(judged({}, { allowed: rows }), "unread")).toContain("drop its row");
  });

  it("reads a class it cannot read against the modules it can come from: those it names, else every one its file imports", () => {
    const top = `\nimport plain from "./plain.module.css";`;
    const withPlain = (extra: string) => usesOf(tree({ top, extra }).set("src/fixture/plain.module.css", ".a { color: var(--fg); }\n"));
    expect(judge(withPlain(`\n      <h3 className={plain[busy]}>{table.name}</h3>`), { allowed: BASE })).toEqual([]);
    expect(checks(judge(withPlain(`\n      <h3 className={classFor(busy)}>{table.name}</h3>`), { allowed: BASE }))).toEqual(["unread"]);
  });

  /* The list, both ways. */
  it("fails on a listed use that no longer exists", () => {
    const f = judged({ baseCss: BASE_CSS.replace(".sql { font-family: var(--font-mono); }", "") });
    expect(message(f, "list")).toBe(`mono :: ${CSS} :: .sql: the allowed row outlives its use`);
  });

  /* The collector's fonts, asked for and not. */
  it("names a font style set in code that it cannot read as unread, and reads fonts only when asked", () => {
    const seed = { extra: `\n      <h3 style={{ fontFamily: faceFor(busy) }}>Parcels</h3>` };
    const unread = collect({ root: "/fixture", sources: tree(seed) }).unresolved.map((u: { kind: string; text: string }) => `${u.kind} :: ${u.text}`);
    expect(unread).toEqual(["style :: fontFamily: faceFor(busy)"]);
    const plain = collectPlain({ root: "/fixture", sources: tree(NEW_STYLES[5][1]) });
    expect(plain.codeStyles.filter((c: { prop: string }) => c.prop === "fontFamily")).toEqual([]);
    expect(plain.unresolved).toEqual([]);
  });
});
