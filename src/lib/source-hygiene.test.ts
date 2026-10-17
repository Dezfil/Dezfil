// The source hygiene checks must actually catch what they exist for, and
// pass the repository as it stands. A check that cannot be shown red is not
// evidence.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-nul-bytes.mjs", import.meta.url),
);
const citations = fileURLToPath(
  new URL("../../scripts/check-internal-citations.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "dezfil-nul-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], guard = script, cwd = repoRoot): { code: number; output: string } {
  try {
    const output = execFileSync("node", [guard, ...args], {
      encoding: "utf8",
      cwd,
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status: number | null; stderr: string };
    return { code: err.status ?? -1, output: err.stderr };
  }
}

describe("NUL-byte hygiene check", () => {
  it("fails loudly on a file containing a NUL byte", () => {
    const bad = join(dir, "Bad.tsx");
    writeFileSync(bad, Buffer.from("const key = `a\0b`;\n"));
    const { code, output } = run([bad]);
    expect(code).toBe(1);
    expect(output).toContain("NUL byte");
    expect(output).toContain("Bad.tsx");
  });

  it("passes a clean file", () => {
    const good = join(dir, "Good.tsx");
    writeFileSync(good, "const key = `a\\nb`;\n");
    const { code } = run([good]);
    expect(code).toBe(0);
  });

  it("passes the whole repository as repaired (the regression)", () => {
    const { code, output } = run([]);
    expect(code).toBe(0);
    expect(output).toContain("PASS");
  });
});

// The seeds are written in pieces so this file never spells a citation the
// guard would find in its own source.
const seed = (...parts: string[]) => parts.join("");
const TRACKING_ROW = seed("N", "-", "123");
const REVIEW_RECORD = [
  seed("review", "s/plan-r1.md"),
  seed("plan-r1-", "findings", ".md"),
  seed("spec-r2-", "reconciliation", ".md"),
  seed("pr-", "review", "-r1.log"),
  seed("plan-r1-", "codex", ".log.gz"),
];

/** A scratch repository with the given files tracked, so the guards run in
 * their whole-tree mode exactly as the gate runs them. */
function scratchRepository(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(dir, "repo-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

describe("internal citation check", () => {
  it("fails on a tracking row seeded in a documentation page, naming the file and line", () => {
    const page = join(dir, "page.md");
    writeFileSync(page, `---\ntitle: "Page"\n---\n\nFixed in ${TRACKING_ROW}.\n`);
    const { code, output } = run([page], citations);
    expect(code).toBe(1);
    expect(output).toContain("page.md:5 cites a tracking row");
  });

  it.each(REVIEW_RECORD)("fails on the review record's file shape %s", (shape) => {
    const page = join(dir, "record.md");
    writeFileSync(page, `The reasoning is in ${shape}, line 4.\n`);
    const { code, output } = run([page], citations);
    expect(code).toBe(1);
    expect(output).toMatch(/record\.md:1 cites a review (record folder|findings file|reconciliation|log)/);
  });

  it("passes the public pages that explain how changes are reviewed and tested", () => {
    const { code, output } = run(
      ["docs/develop/how-this-is-built.md", "docs/develop/checks-and-testing.md"],
      citations,
    );
    expect(output).toContain("PASS");
    expect(code).toBe(0);
  });

  it("passes prose about review and reconciliation that names no record file", () => {
    const page = join(dir, "prose.md");
    writeFileSync(page, "Each change is reviewed; a stale save needs reconciliation. See preview.log.\n");
    expect(run([page], citations).code).toBe(0);
  });
});

describe("recordings are binary to both guards", () => {
  // The same bytes under two names: a recording holds NUL bytes and may hold
  // any byte pattern, a citation's included, by chance.
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]), Buffer.from(` ${TRACKING_ROW} `)]);

  it("skips a tracked .webm file and still scans the same bytes under a text name", () => {
    const clean = scratchRepository({ "docs/images/guides/search.webm": bytes });
    expect(run([], script, clean).code).toBe(0);
    expect(run([], citations, clean).code).toBe(0);

    const text = scratchRepository({ "docs/images/guides/search.txt": bytes });
    const nul = run([], script, text);
    expect(nul.code).toBe(1);
    expect(nul.output).toContain("search.txt");
    const cited = run([], citations, text);
    expect(cited.code).toBe(1);
    expect(cited.output).toContain("search.txt:1 cites a tracking row");
  });
});
