import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The Data page has one name (widened at to every door that leads
 * there): no user-facing string may still call it "Data Explorer". Read
 * syntax-aware, as the copy boundary is: string literals, template text
 * and JSX text through the TypeScript AST, so a comment recalling the
 * old name is not a landing. Test files are outside the sweep (their
 * names and fixtures are not copy); everything else under src is.
 */

const ROOT = "src";
const OLD_NAME = "Data Explorer";

export function oldNameSites(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isJsxText(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      node.text.includes(OLD_NAME)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.add(`${file}:${line + 1} :: ${lines[line].trim()}`);
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

describe("the Data page's one name", () => {
  const found: string[] = [];
  let filesScanned = 0;
  for (const file of walk(ROOT)) {
    filesScanned += 1;
    found.push(...oldNameSites(file, readFileSync(file, "utf8")));
  }

  it("actually scans the tree, and the collector sees a landing when there is one", () => {
    expect(filesScanned).toBeGreaterThan(300);
    expect(
      oldNameSites("probe.tsx", 'const a = "Open in Data Explorer"; // Data Explorer\n<p>Back to Data Explorer</p>;'),
    ).toHaveLength(2);
  });

  it("no user-facing string still says Data Explorer", () => {
    expect(found, "the page is called Data; rename the door").toEqual([]);
  });
});
