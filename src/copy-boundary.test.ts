import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The copy boundary: no em dash in user-facing copy. The collector
 * reads source syntax-aware — string literals, template text and JSX
 * text through the TypeScript AST, so comments are excluded
 * structurally and a URL can never masquerade as one. Its only
 * exceptions are ruled and two-way: the bare "—" no-value glyph sites
 * by exact identity, and the deferred contract-prose files by
 * name. There is no general "internal prose" allowance — a string no
 * screen renders still carries no dash. A vanished glyph site fails as
 * a stale allowance until its row is removed; a new dash anywhere else
 * fails as growth.
 */

const ROOT = "src";
const DASH = "—";

/** Contract prose deferred to its own decision: the
 * OpenAPI document, the operations catalogue, and the MCP tool
 * descriptors — the same prose served to agents. The error catalogue
 * is NOT here: its sentences trace to a rendered
 * published-view state, so the guard holds it like any copy. */
const DEFERRED_FILES = new Set([
  "src/lib/api/openapi.ts",
  "src/lib/operations/catalog.ts",
  "src/lib/tools/tools.ts",
]);

/** The ruled no-value glyph: "—" standing alone in a stat slot.
 * Exact site identities, two-way. */
const GLYPH_SITES = new Set([
  'src/components/OsmPane.tsx :: <b>{areaKm2 === null ? "—" : formatKm2(areaKm2)}</b>',
  'src/components/OverturePane.tsx :: <b>{area === null ? "—" : formatKm2(area)}</b>',
  'src/components/connections/ConnectionsLedger.tsx :: <span className={styles.count}>{snapshots.length ? formatCount(snapshots.length) : "—"}</span>',
  'src/components/data-cards.tsx :: t.geometryColumn === null ? "—" : t.geometryType || "Geometry";',
  'src/components/api.ts :: if (n === null || n === undefined || !Number.isFinite(n)) return "—";',
  // The workflow card's run slot when the history read failed.
  'src/components/projects/home-model.ts :: if (newestRun === "unreadable") return "—";',
  'src/components/builder/StatusBar.tsx :: <span className={styles.val}>{text ?? "—"}</span>',
  'src/components/builder/StatusBar.tsx :: {status ? formatZoom(status.zoom) : "—"}',
  'src/components/builder/drawer/parameter-controls.tsx :: placeholder="—"',
  'src/components/widgets/WidgetRail.tsx :: if (n === null || !Number.isFinite(n)) return "—";',
  'src/lib/operations/summary.ts :: if (value === null || value === undefined) return "—";',
  'src/lib/widgets.ts :: if (n === null || !Number.isFinite(n)) return "—";',
]);

/** File :: trimmed source line for every dash landing in string,
 * template or JSX text — comments never reach the AST as text. */
export function dashSites(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");
  const found = new Set<string>();
  const record = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.add(`${file} :: ${lines[line].trim()}`);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isJsxText(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      node.text.includes(DASH)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found];
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx|ts)$/.test(full) && !/\.test\./.test(full)) yield full;
  }
}

describe("the copy boundary", () => {
  const found = new Set<string>();
  let filesScanned = 0;
  let deferredSkipped = 0;
  for (const file of walk(ROOT)) {
    filesScanned += 1;
    if (DEFERRED_FILES.has(file)) {
      deferredSkipped += 1;
      continue;
    }
    for (const site of dashSites(file, readFileSync(file, "utf8"))) {
      found.add(site);
    }
  }

  it("actually scans the tree (the check is not vacuous)", () => {
    expect(filesScanned).toBeGreaterThan(300);
    // Every deferred file must still exist — a renamed contract file
    // would silently widen the boundary.
    expect(deferredSkipped).toBe(DEFERRED_FILES.size);
    // The glyph sites are live landings the collector really sees.
    expect(found.size).toBeGreaterThanOrEqual(GLYPH_SITES.size);
  });

  it("no dash lands outside the ruled glyph sites (growth fails)", () => {
    const growth = [...found].filter((site) => !GLYPH_SITES.has(site));
    expect(
      growth,
      "an em dash reached user-facing copy — rewrite it (a period, colon, comma or ·), or a spec extends the ruled exceptions",
    ).toEqual([]);
  });

  it("no glyph row outlives its site (stale allowances fail)", () => {
    const stale = [...GLYPH_SITES].filter((site) => !found.has(site));
    expect(
      stale,
      "a ruled glyph site no longer exists — shrink the exception list",
    ).toEqual([]);
  });

  it("rejects the three ruled classes fed through the real collector", () => {
    // Rendered prose (JSX text), an accessible name (a string literal in JSX), and a runtime
    // message (template text in a .ts module): each seeded dash must surface as growth against the
    // exceptions.
    const seeds: [string, string, string][] = [
      [
        "src/components/Fake.tsx",
        "export const F = () => <p>Saved — the view uses it too.</p>;",
        "src/components/Fake.tsx :: export const F = () => <p>Saved — the view uses it too.</p>;",
      ],
      [
        "src/components/Fake.tsx",
        'export const F = () => <button aria-label="Legend title — Roads" />;',
        'src/components/Fake.tsx :: export const F = () => <button aria-label="Legend title — Roads" />;',
      ],
      [
        "src/lib/fake.ts",
        "export const m = (n: number) => `${n} rows — too many to draw`;",
        "src/lib/fake.ts :: export const m = (n: number) => `${n} rows — too many to draw`;",
      ],
    ];
    for (const [file, source, identity] of seeds) {
      const sites = dashSites(file, source);
      expect(sites, source).toEqual([identity]);
      expect(GLYPH_SITES.has(sites[0])).toBe(false);
    }
  });

  it("ignores comments of every kind (negative controls)", () => {
    const clean = [
      "// a line comment — with a dash\nexport const a = 1;",
      "/* a block comment — with a dash */\nexport const b = 2;",
      "export const C = () => (\n  <div>\n    {/* a JSX comment — with a dash */}\n    <p>text</p>\n  </div>\n);",
      'export const url = "https://example.com/path"; // trailing — dash',
    ];
    for (const source of clean) {
      expect(dashSites("src/components/Fake.tsx", source), source).toEqual([]);
    }
  });
});
