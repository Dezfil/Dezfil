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
import { WRITING_LIST, checkWriting, readList } from "../../scripts/docs-writing.mjs";

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
