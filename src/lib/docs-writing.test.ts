// The documentation's writing rules, held by `npm run lint:docs` beside the
// page contract. A page on the list of pages not yet rewritten is skipped by
// the writing rules and held by every other check.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { generateIndex } from "../../scripts/docs-contract.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { WRITING_LIST, checkWriting, colonLine, measure, median, readList, words } from "../../scripts/docs-writing.mjs";

type Problem = { file: string; rule: string; message: string; line?: number };
const cases = JSON.parse(readFileSync("test-support/docs-contract/cases.json", "utf8")) as { base: Record<string, string> };

const script = fileURLToPath(new URL("../../scripts/docs.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-writing-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const lines = (problems: Problem[]) => problems.map(({ file, rule, line }) => (line === undefined ? { file, rule } : { file, rule, line }));
const writing = (files: Record<string, string>) =>
  checkWriting({ files: Object.keys(files), read: (file: string) => files[file] }) as { problems: Problem[]; checked: string[]; listed: string[] };

describe("the list of pages not yet rewritten", () => {
  it("reads one page path per line, past comments and blank lines, with each entry's line", () => {
    expect(readList("# The pages.\n\ndocs/start/install.md\n  docs/use/templates.md  \n")).toEqual([
      { path: "docs/start/install.md", line: 3 },
      { path: "docs/use/templates.md", line: 4 },
    ]);
  });

  it("sits beside the checks and names only pages the repository holds", () => {
    expect(WRITING_LIST).toBe("scripts/docs-not-rewritten.txt");
    const listed = readList(readFileSync(WRITING_LIST, "utf8")).map((entry: { path: string }) => entry.path);
    const pages = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "docs/*.md"], { encoding: "utf8" })
      .split("\n").filter((file) => file && file !== "docs/README.md");
    expect(listed.length).toBe(new Set(listed).size);
    for (const page of listed) expect(pages).toContain(page);
  });

  it("leaves a listed page out of the writing rules and says which pages it read", () => {
    const files = { ...cases.base, [WRITING_LIST]: "docs/start/install.md\n" };
    const result = writing(files);
    expect(result.problems).toEqual([]);
    expect(result.listed).toEqual(["docs/start/install.md"]);
    expect(result.checked).toEqual(["docs/api/mcp.md", "docs/use/templates.md"]);
  });

  it.each([
    ["a path that is no page", "docs/start/install.md\ndocs/start/gone.md\n", 2],
    ["a path listed twice", "docs/start/install.md\ndocs/use/templates.md\ndocs/start/install.md\n", 3],
    ["a file under docs/ that is not a page", "docs/README.md\n", 1],
  ])("refuse %s, named by the list's file and line", (_name, list, line) => {
    const files = { ...cases.base, [WRITING_LIST]: list };
    expect(lines(writing(files).problems)).toEqual([{ file: WRITING_LIST, rule: "writing.list-entry", line }]);
  });
});

type Unit = { kind: string; line: number; words: number };
const units = (body: string, firstLine = 1) =>
  (measure(body, firstLine) as { units: Unit[] }).units.map(({ kind, line, words: count }) => ({ kind, line, words: count }));
const total = (body: string) => (measure(body) as { words: unknown[] }).words.length;

describe("measuring prose", () => {
  it("counts runs of letters and digits as words", () => {
    expect(words("Dezfil's limit is 10,240 MB: set `DEZFIL_UPLOAD_MAX_MB`, café.")).toEqual(
      ["Dezfil", "s", "limit", "is", "10", "240", "MB", "set", "DEZFIL", "UPLOAD", "MAX", "MB", "café"],
    );
    expect(words("— -> …")).toEqual([]);
  });

  it("takes the median of an even count as the mean of the two middle values", () => {
    expect(median([31, 5, 40])).toBe(31);
    expect(median([30, 10, 31, 90])).toBe(30.5);
    expect(median([29, 31, 1, 80])).toBe(30);
  });

  it("counts a link by its text, inline code as words, and not a picture's text", () => {
    expect(units("Open [the install page](../start/install.md#first-run), run `npm run dev` and see <http://localhost:3000>.\n")).toEqual([
      { kind: "paragraph", line: 1, words: 13 },
    ]);
    expect(units("![The setup page with its three fields](../images/start/setup-card.webp)\n")).toEqual([{ kind: "paragraph", line: 1, words: 0 }]);
  });

  it("counts each list item's own text once, a nested item as its own item", () => {
    const body = "- **Time:** about ten minutes.\n- Outer item one two\n  - inner three\n    - innermost four five\n";
    expect(units(body)).toEqual([
      { kind: "item", line: 1, words: 4 },
      { kind: "item", line: 2, words: 4 },
      { kind: "item", line: 3, words: 2 },
      { kind: "item", line: 4, words: 3 },
    ]);
    expect(total(body)).toBe(13);
  });

  it("counts a notice as one unit, without its marker, and its list items as its own text", () => {
    expect(units("> [!WARNING]\n> The first person to finish setup becomes the admin.\n>\n> - Keep it private.\n")).toEqual([
      { kind: "notice", line: 1, words: 12 },
    ]);
  });

  it("leaves out headings, tables, code blocks, HTML comments and generated regions", () => {
    const body = [
      "## A heading of five words",
      "",
      "| Task | Command |",
      "|---|---|",
      "| Stop | `docker stop dezfil` |",
      "",
      "```sh title=\"Terminal\"",
      "docker run dezfil",
      "```",
      "",
      "<!-- a comment of words -->",
      "",
      "<!-- error-catalogue:start -->",
      "Generated prose that a generator owns.",
      "",
      "- and a generated item",
      "<!-- error-catalogue:end -->",
      "",
      "One paragraph.",
      "",
    ].join("\n");
    expect(units(body, 10)).toEqual([{ kind: "paragraph", line: 28, words: 2 }]);
  });

  it("reads the tab lines as no prose and what the tabs hold as prose, even packed without blank lines", () => {
    const body = [
      "::::tabs",
      ":::tab[Docker Compose]",
      "Run it with Compose.",
      ":::",
      ":::tab[Any other client]",
      "> [!NOTE]",
      "> A client in the cloud.",
      ":::",
      "::::",
      "After the set.",
      "",
    ].join("\n");
    expect(units(body)).toEqual([
      { kind: "paragraph", line: 3, words: 4 },
      { kind: "notice", line: 6, words: 5 },
      { kind: "paragraph", line: 10, words: 3 },
    ]);
  });

  it("keeps a tab line inside a code block as code", () => {
    expect(colonLine(":::tab[Docker]")).toEqual({ kind: "tab-open", label: "Docker" });
    expect(colonLine("::: not a tab line")).toBeNull();
    const read = (measure("```text title=\"Syntax\"\n::::tabs\n:::\n```\n") as { read: { markers: unknown[] } }).read;
    expect(read.markers).toEqual([]);
  });

  it("orders the prose's words as the page reads, each on its own line", () => {
    const found = (measure("First\nsecond line.\n\n- third\n", 5) as { words: { line: number }[] }).words;
    expect(found.map((word) => word.line)).toEqual([5, 6, 6, 8]);
  });
});

describe("the lint:docs command", () => {
  function run(root: string): { code: number; output: string } {
    try {
      const output = execFileSync("node", [script, "--check", "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, output };
    } catch (error) {
      const failed = error as { status: number | null; stderr: string };
      return { code: failed.status ?? -1, output: failed.stderr };
    }
  }

  function write(files: Record<string, string>): string {
    const root = mkdtempSync(join(scratch, "tree-"));
    const all = { ...files, "docs/README.md": generateIndex({ files: [...Object.keys(files), "docs/README.md"], read: (file: string) => files[file] }) };
    for (const [file, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  }

  it("fails a list entry that names no page, with the list's file, line and rule", () => {
    const { code, output } = run(write({ ...cases.base, [WRITING_LIST]: "# Not yet rewritten.\ndocs/start/gone.md\n" }));
    expect(output).toMatch(/^scripts\/docs-not-rewritten\.txt:2: writing\.list-entry: /m);
    expect(output).toContain("FAIL: 1 documentation problem(s).");
    expect(code).toBe(1);
  });
});
