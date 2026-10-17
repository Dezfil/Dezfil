// The documentation's page contract, held by `npm run lint:docs`. Every rule
// is shown red by a seeded case, and the cases are the shared list the
// documentation site's build runs too, so the two sides are compared on the
// same documents rather than assumed to agree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { checkPageText, checkTree, comparePages, frontmatterValues, headings, references } from "../../scripts/docs-contract.mjs";

type Problem = { file: string; rule: string; message: string; line?: number };
type Files = Record<string, string | null>;
const cases = JSON.parse(readFileSync("test-support/docs-contract/cases.json", "utf8")) as {
  today: string;
  documentCase: string;
  base: Record<string, string>;
  documents: { name: string; text: string; valid: boolean; values?: Record<string, unknown>; rules?: string[] }[];
  trees: { name: string; files: Files; problems: { file: string; rule: string }[] }[];
  order: { name: string; pages: { path: string; title: string; order?: number }[]; expected: string[] }[];
};

const script = fileURLToPath(new URL("../../scripts/docs.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-contract-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function tree(over: Files = {}): Record<string, string> {
  const files: Record<string, string> = { ...cases.base };
  for (const [file, text] of Object.entries(over)) {
    if (text === null) delete files[file]; else files[file] = text;
  }
  return files;
}

function check(files: Record<string, string>): Problem[] {
  return (checkTree({ files: Object.keys(files), read: (file: string) => files[file], on: cases.today }) as { problems: Problem[] }).problems;
}

const shape = (problems: Problem[]) => problems.map(({ file, rule }) => ({ file, rule }));

describe("the shared contract cases", () => {
  it("accept the base tree as it stands", () => {
    expect(check(tree())).toEqual([]);
  });

  it.each(cases.documents.filter((d) => d.valid))("accept a valid document: $name", ({ text, values }) => {
    const { problems, page } = checkPageText(text, { file: cases.documentCase, on: cases.today });
    expect(problems).toEqual([]);
    expect(frontmatterValues(page.data)).toEqual(values);
    expect(check(tree({ [cases.documentCase]: text }))).toEqual([]);
  });

  it.each(cases.documents.filter((d) => !d.valid))("refuse an invalid document with its rule: $name", ({ text, rules }) => {
    const problems = check(tree({ [cases.documentCase]: text }));
    expect(shape(problems)).toEqual(rules!.map((rule) => ({ file: cases.documentCase, rule })));
    expect(problems.every((p) => p.message.length > 0)).toBe(true);
  });

  it.each(cases.trees)("refuse a seeded tree with exactly its problems: $name", ({ files, problems }) => {
    expect(shape(check(tree(files)))).toEqual(problems);
  });

  it.each(cases.order)("sort pages in reading order: $name", ({ pages, expected }) => {
    expect([...pages].sort(comparePages).map((p) => p.path)).toEqual(expected);
  });

  it("seed every rule the contract names at least once", () => {
    const seeded = new Set([
      ...cases.documents.flatMap((d) => d.rules ?? []),
      ...cases.trees.flatMap((t) => t.problems.map((p) => p.rule)),
    ]);
    const source = readFileSync("scripts/docs-contract.mjs", "utf8");
    const named = new Set([...source.matchAll(/"((?:frontmatter|body|link|image|moved-from|address|tree|manifest)\.[a-z-]+)"/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(20);
    for (const rule of named) expect(seeded, rule).toContain(rule);
  });
});

describe("reading a page", () => {
  it("makes anchors the way the site and GitHub do", () => {
    const list = headings("## The `lint:docs` gate\n\n## Run it, **now**\n\n## Run it, now\n\nSetext two\n---\n\n## Ports & `DEZFIL_DATA_DIR`\n");
    expect(list.map((h: { anchor: string }) => h.anchor)).toEqual([
      "the-lintdocs-gate", "run-it-now", "run-it-now-1", "setext-two", "ports--dezfil_data_dir",
    ]);
  });

  it("finds links and pictures outside code only, with their lines", () => {
    const found = references("[a](x.md)\n\n```\n[b](y.md)\n```\n\n`[c](z.md)` [d\ne](w.md) [![alt](p.webp)](q.md)\n", 10);
    expect(found).toEqual([
      { type: "image", target: "p.webp", alt: "alt", line: 17 },
      { type: "link", target: "x.md", line: 10 },
      { type: "link", target: "w.md", line: 16 },
      { type: "link", target: "q.md", line: 17 },
    ]);
  });
});

describe("the lint:docs command", () => {
  function run(root?: string): { code: number; output: string } {
    try {
      const output = execFileSync("node", [script, "--check", ...(root ? ["--root", root] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, output };
    } catch (error) {
      const failed = error as { status: number | null; stderr: string };
      return { code: failed.status ?? -1, output: failed.stderr };
    }
  }

  function write(files: Record<string, string>): string {
    const root = mkdtempSync(join(scratch, "tree-"));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  }

  it("passes the repository's own documentation", () => {
    const { code, output } = run();
    expect(output).toContain("PASS");
    expect(code).toBe(0);
  });

  it("fails a seeded tree and names the file, the line and the rule", () => {
    const seeded = cases.trees.find((t) => t.name === "a dead page link")!;
    const { code, output } = run(write(tree(seeded.files)));
    expect(code).toBe(1);
    expect(output).toMatch(/^docs\/start\/run-it\.md:\d+: link\.dead-page: /m);
    expect(output).toContain("FAIL: 1 documentation problem(s).");
  });
});
