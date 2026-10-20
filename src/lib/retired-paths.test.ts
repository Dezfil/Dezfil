import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_LINES, LIST_FILE, RETIRED_FOLDERS, RETIRED_PATHS, findRetiredPaths, retiredPathsIn } from "../../scripts/check-retired-paths.mjs";

type Hit = { file: string; line: number; path: string };
const found = (file: string, text: string) => (retiredPathsIn(file, text) as Hit[]).map((hit) => [hit.line, hit.path]);

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

describe("the retired documentation paths", () => {
  it("are named nowhere in the tracked tree outside the exceptions", () => {
    expect(findRetiredPaths({ files: tracked, read: (file: string) => readFileSync(file, "utf8") })).toEqual([]);
  });

  it("are found as a repository path, a site address, a repository address and a relative link", () => {
    const text = [
      "// The steps are in docs/reference/mcp.md.", // retired-path fixture
      "const guide = \"https://dezfil.io/docs/operate/runbook/\";", // retired-path fixture
      "See https://github.com/Dezfil/Dezfil/blob/main/docs/develop/architecture.md.", // retired-path fixture
      "[the limits](../reference/sql-limits.md#result-size)", // retired-path fixture
      "Read the folder docs/develop/ first.", // retired-path fixture
      "The section page docs/guides holds one page.", // retired-path fixture
      "![a picture](../images/guides/templates.webp)", // retired-path fixture
    ].join("\n");
    // One hit for each place a path is named, by the first entry that names it.
    expect(found("scripts/example.mjs", text)).toEqual([
      [1, "docs/reference"], // retired-path fixture
      [2, "docs/operate"], // retired-path fixture
      [3, "docs/develop"], // retired-path fixture
      [4, "reference/sql-limits"], // retired-path fixture
      [5, "docs/develop"], // retired-path fixture
      [6, "docs/guides"], // retired-path fixture
      [7, "images/guides"], // retired-path fixture
    ]);
  });

  it("are not found inside a longer name, a live page or another site's address", () => {
    const text = [
      "the tokens page reference/api-tokens and my-reference/api stay", // retired-path fixture
      "docs/api/mcp.md, docs/self-host/configuration.md and docs/use/templates.md are live",
      "https://example.org/docs/reference/mcp/ is that site's own page", // retired-path fixture
    ].join("\n");
    expect(found("scripts/example.mjs", text)).toEqual([]);
  });

  it("cover every address a page has moved from", () => {
    const moved = tracked
      .filter((file) => /^docs\/.+\.md$/.test(file))
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/^ {2}- "\/docs\/([^"]+?)\/"$/gm)].map((m) => m[1]));
    expect(moved.length).toBeGreaterThan(10);
    for (const address of moved) {
      expect(found("scripts/example.mjs", `docs/${address}.md`), address).not.toEqual([]);
      expect(found("scripts/example.mjs", `https://dezfil.io/docs/${address}/`), address).not.toEqual([]);
    }
  });

  it("name no file the tree holds now", () => {
    const live = tracked.filter((file) => file.startsWith("docs/") || file.startsWith("scripts/") || file.startsWith("src/"));
    expect(found("scripts/example.mjs", live.filter((file) => file !== LIST_FILE).join("\n"))).toEqual([]);
    for (const entry of [...RETIRED_PATHS, ...RETIRED_FOLDERS]) {
      expect(tracked.some((file) => file.startsWith(`docs/${entry.replace(/^docs\//, "")}`)), entry).toBe(false);
    }
  });
});

describe("the exceptions cover one line each", () => {
  it("a page's moved_from rows, and nothing else in the page", () => {
    const page = [
      "---",
      "title: \"MCP\"",
      "moved_from:",
      "  - \"/docs/reference/mcp/\"", // retired-path fixture
      "checked: none",
      "---",
      "",
      "The old address was /docs/reference/mcp/.", // retired-path fixture
      "  - \"/docs/reference/mcp/\"", // retired-path fixture
    ].join("\n");
    expect(found("docs/api/mcp.md", page)).toEqual([[8, "docs/reference"], [9, "docs/reference"]]); // retired-path fixture
    // The same row outside a page is not a redirect.
    expect(found("scripts/example.mjs", page)).toEqual([[4, "docs/reference"], [8, "docs/reference"], [9, "docs/reference"]]); // retired-path fixture
  });

  it("the list, between its markers, and nothing after them", () => {
    const source = readFileSync(LIST_FILE, "utf8");
    expect(found(LIST_FILE, source)).toEqual([]);
    const after = `${source}\n// docs/operate/runbook.md\n`; // retired-path fixture
    const line = after.split("\n").length - 1;
    expect(found(LIST_FILE, after)).toEqual([[line, "docs/operate"]]); // retired-path fixture
    // The list read from any other file is no exception.
    expect(found("scripts/example.mjs", source).length).toBeGreaterThan(RETIRED_PATHS.length);
  });

  it("a marked fixture line in a test file, and only there", () => {
    const line = "const old = \"docs/reference/mcp.md\"; // retired-path fixture"; // retired-path fixture
    expect(found("src/lib/example.test.ts", line)).toEqual([]);
    expect(found("test-support/example.json", line)).toEqual([]);
    expect(found("src/lib/example.ts", line)).toEqual([[1, "docs/reference"]]); // retired-path fixture
    expect(found("src/lib/example.test.ts", `${line}\nconst again = "docs/reference/mcp.md";`)).toEqual([[2, "docs/reference"]]); // retired-path fixture
  });

  it("a named fixture line, in its own file only", () => {
    const [file, piece] = FIXTURE_LINES[0] as [string, string];
    const text = `${piece}: "a case"\n${piece.replace("case", "other")}: "another"`;
    expect(found(file, text)).toEqual([[2, "docs/reference"]]); // retired-path fixture
    expect(found("test-support/other.json", text)).toEqual([[1, "docs/reference"], [2, "docs/reference"]]); // retired-path fixture
  });
});
