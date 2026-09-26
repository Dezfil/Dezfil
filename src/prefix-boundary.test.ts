import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The prefix boundary (piece 6): no hand-written
 * `-webkit-backdrop-filter` anywhere under src. The CSS pipeline
 * (lightningcss under Turbopack) prefixes a bare `backdrop-filter`
 * itself, and where a stylesheet writes both spellings by hand it keeps
 * only the prefix, which the browser ignores: the glass stops blurring.
 * The computed-style check in e2e/workflow-look.spec.ts holds five
 * surfaces; this holds the mechanism for every stylesheet, without a
 * browser. A re-added prefix line reads as a good deed in a diff, which
 * is exactly why a guard is needed.
 */

const ROOT = "src";
const FORBIDDEN = /-webkit-backdrop-filter\s*:/;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (full.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("the prefix boundary", () => {
  it("no stylesheet under src writes -webkit-backdrop-filter by hand", () => {
    const files = cssFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => FORBIDDEN.test(line))
        .map(({ i }) => `${file}:${i + 1}`),
    );
    expect(offenders, "hand-written -webkit-backdrop-filter lines (the pipeline prefixes; a hand-written one drops the standard declaration)").toEqual([]);
  });
});
