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
import { checkIndex, checkPageText, checkTree, frontmatterValues, generateIndex, headings, indexOrder, references } from "../../scripts/docs-contract.mjs";

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
    expect(indexOrder(pages).map((p: { path: string }) => p.path)).toEqual(expected);
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

describe("the agents' index", () => {
  const files = tree();
  const read = (file: string) => files[file];
  const index = generateIndex({ files: Object.keys(files), read }) as string;

  it("lists the six sections in order with their descriptions, an empty one by its description alone", () => {
    const sections = [...index.slice(0, index.indexOf("## Also")).matchAll(/^## (.+)\n\n(.+)$/gm)].map((m) => [m[1], m[2]]);
    expect(sections).toEqual([
      ["Start", "What Dezfil is and your first map."],
      ["Guides", "How to do each thing in the app."],
      ["Reference", "The exact rules: the API, MCP, configuration, limits, formats, shortcuts."],
      ["Operate", "Running an instance."],
      ["Develop", "Changing the code."],
      ["About", "Licence, credits, changes and policies."],
    ]);
    expect(index).toContain("## Operate\n\nRunning an instance.\n\n## Develop");
  });

  it("gives each page one entry with its six fields in order", () => {
    expect(index).toContain([
      "- [MCP](reference/mcp.md)",
      "  - path: `docs/reference/mcp.md`",
      "  - summary: How an agent drives Dezfil through its MCP server, folded over two lines.",
      "  - read when: you connect an agent; you read the tool list",
      "  - audience: agent, developer",
      "  - checked: 0.1.0, 2026-10-01",
    ].join("\n"));
    expect(index.match(/^- \[/gm)!.length - 4).toBe(3);
  });

  it("ends with the imported documents and their fixed summaries", () => {
    expect(index.slice(index.indexOf("## Also"))).toBe([
      "## Also",
      "",
      "- [Changelog](../CHANGELOG.md) (About): What changed in each release.",
      "- [Security policy](../SECURITY.md) (About): Which versions get fixes and how to report a vulnerability.",
      "- [Contributing](../CONTRIBUTING.md) (Develop): How to get a change from your machine into the project.",
      "- [Code of conduct](../CODE_OF_CONDUCT.md) (Develop): The standards for taking part and how they are enforced.",
      "",
    ].join("\n"));
  });

  it("names the generated files beside the pages once they exist", () => {
    const more: Record<string, string> = { ...files, "docs/reference/openapi.json": "{}", "docs/images/manifest.json": "{\"rows\": []}" };
    const fuller = generateIndex({ files: Object.keys(more), read: (file: string) => more[file] }) as string;
    expect(fuller).toContain("- [The OpenAPI description](reference/openapi.json)");
    expect(fuller).toContain("- [The image manifest](images/manifest.json)");
  });

  it("is held fresh: a summary changed without regenerating fails, a missing index fails", () => {
    const current: Record<string, string> = { ...files, "docs/README.md": index };
    const at = (set: Record<string, string>) => checkIndex({ files: Object.keys(set), read: (file: string) => set[file] }) as Problem[];
    expect(at(current)).toEqual([]);
    const edited: Record<string, string> = { ...current, "docs/guides/templates.md": current["docs/guides/templates.md"].replace("Start a map from a template", "Begin a map from a template") };
    expect(shape(at(edited))).toEqual([{ file: "docs/README.md", rule: "index.stale" }]);
    expect(shape(at(files))).toEqual([{ file: "docs/README.md", rule: "index.stale" }]);
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
    const files = tree(seeded.files);
    files["docs/README.md"] = generateIndex({ files: Object.keys(files), read: (file: string) => files[file] });
    const { code, output } = run(write(files));
    expect(code).toBe(1);
    expect(output).toMatch(/^docs\/start\/run-it\.md:\d+: link\.dead-page: /m);
    expect(output).toContain("FAIL: 1 documentation problem(s).");
  });
});
