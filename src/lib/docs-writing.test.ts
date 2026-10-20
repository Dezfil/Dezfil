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
import { checkTree, generateIndex } from "../../scripts/docs-contract.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { OPERATOR_SCRIPTS, WRITING_LIST, checkPageWriting, checkWriting, colonLine, measure, median, readList, words, writingNames } from "../../scripts/docs-writing.mjs";
import { SETTING_CATALOGUE, TEST_WIRING } from "@/lib/settings/catalogue";

type Problem = { file: string; rule: string; message: string; line?: number };
type Names = { variables: string[]; keys: string[]; codes: string[] };
type Seeded = { scope?: string; name: string; files: Record<string, string | null>; problems: { file: string; rule: string; line?: number }[] };
const cases = JSON.parse(readFileSync("test-support/docs-contract/cases.json", "utf8")) as {
  today: string;
  base: Record<string, string>;
  product: { files: Record<string, string>; names: Names };
  documents: { scope?: string; name: string }[];
  trees: Seeded[];
};
const productCases = cases.trees.filter((t) => t.scope === "product");
/** A sentence of `n` words. */
const w = (n: number) => `${Array.from({ length: n }, () => "word").join(" ")}.`;

const script = fileURLToPath(new URL("../../scripts/docs.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-writing-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const lines = (problems: Problem[]) => problems.map(({ file, rule, line }) => (line === undefined ? { file, rule } : { file, rule, line }));
const writing = (files: Record<string, string>) =>
  checkWriting({ files: Object.keys(files), read: (file: string) => files[file] }) as { problems: Problem[]; checked: string[]; listed: string[] };

/** The base tree with the product's files laid over it, then a case's;
 * null removes a file. */
function productTree(over: Record<string, string | null>): Record<string, string> {
  const files: Record<string, string> = { ...cases.base, ...cases.product.files };
  for (const [file, text] of Object.entries(over)) {
    if (text === null) delete files[file]; else files[file] = text;
  }
  return files;
}

/** Every page check the lint makes, as lint:docs makes them: the page
 * contract, then the writing rules. */
function pageChecks(files: Record<string, string>, names: Names = cases.product.names): Problem[] {
  const list = Object.keys(files);
  const read = (file: string) => files[file];
  return [
    ...(checkTree({ files: list, read, on: cases.today }) as { problems: Problem[] }).problems,
    ...(checkWriting({ files: list, read, names }) as { problems: Problem[] }).problems,
  ];
}

describe("the product's shared cases", () => {
  it("mark every case common or the product's own, and the product holds some", () => {
    for (const entry of [...cases.documents, ...cases.trees]) {
      if ("scope" in entry) expect(entry.scope, entry.name).toBe("product");
    }
    expect(productCases.length).toBeGreaterThan(10);
  });

  it("accept the base tree under the product's files", () => {
    expect(pageChecks(productTree({}))).toEqual([]);
  });

  it.each(productCases)("refuse a seeded tree with exactly its problems, each at its line: $name", ({ files, problems }) => {
    const found = pageChecks(productTree(files));
    expect(lines(found)).toEqual(problems);
    expect(found.every((p) => p.message.length > 0 && !p.message.includes("\n"))).toBe(true);
  });

  it("seed every writing rule the module names at least once, and only in the product's cases", () => {
    const source = readFileSync("scripts/docs-writing.mjs", "utf8");
    const named = new Set([...source.matchAll(/"(writing\.[a-z-]+)"/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(20);
    const seeded = new Set(productCases.flatMap((t) => t.problems.map((p) => p.rule)));
    for (const rule of named) expect(seeded, rule).toContain(rule);
    const common = cases.trees.filter((t) => !("scope" in t)).flatMap((t) => t.problems.map((p) => p.rule));
    expect(common.filter((rule) => rule.startsWith("writing."))).toEqual([]);
  });
});

describe("the rules on one page", () => {
  const check = (file: string, body: string) => lines(checkPageWriting({ file, page: { data: {}, body, bodyLine: 10 } }) as Problem[]);

  it("leave a paragraph that holds only a picture out of the median", () => {
    const body = ["![A picture of the map](../images/use/map.webp)", "", w(10), "", w(31), "", w(31), "", w(31), ""].join("\n");
    expect(check("docs/use/case.md", body)).toEqual([]);
    expect(check("docs/use/case.md", `${w(5)}\n\n${body}`)).toEqual([{ file: "docs/use/case.md", rule: "writing.median-paragraph", line: 16 }]);
  });

  it.each([
    ["a picture", "![The builder with its layers](../images/use/builder.webp)"],
    ["a recording", "![Typing into the search box narrows the cards](../images/use/search.webm)"],
    ["a picture by reference", "![The builder][builder]\n\n[builder]: ../images/use/builder.webp"],
    ["a picture in HTML", "<img src=\"../images/use/builder.webp\" alt=\"The builder\">"],
  ])("take %s as something to see on the first screen", (_name, shown) => {
    const opening = `${w(75)}\n\n${w(75)}\n\n`;
    expect(check("docs/use/case.md", `${opening}${shown}\n\n${w(40)}\n`)).toEqual([]);
    expect(check("docs/use/case.md", `${opening}${w(1)}\n\n${shown}\n\n${w(40)}\n`)).toEqual([{ file: "docs/use/case.md", rule: "writing.first-screen", line: 14 }]);
  });

  it.each([
    ["The key is used to sign in.", []],
    ["It's used to sign in, and tokens are mostly used to script.", []],
    ["A token is not used to publish.", []],
    ["The proxy is not always used to reach the provider.", []],
    ["The proxy is the one people used to reach it.", ["writing.word"]],
    ["The key once used to sign in.", ["writing.word"]],
    ["Dezfil used to ask for a key, and people used to wait.", ["writing.word", "writing.word"]],
  ])("read \"used to\" after a form of \"be\" as a description: %s", (text, rules) => {
    expect(check("docs/about/case.md", `${text}\n`).map((p) => p.rule)).toEqual(rules);
  });

  it("let a page outside Contribute name only the scripts the image ships for operators", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(OPERATOR_SCRIPTS).toEqual(["scripts/admin-recover.mjs"]);
    for (const script of OPERATOR_SCRIPTS) {
      expect(dockerfile).toMatch(new RegExp(`^COPY .*\\s/app/${script.replace(/[.]/g, "\\.")}\\s+\\./${script.replace(/[.]/g, "\\.")}$`, "m"));
    }
    expect(check("docs/self-host/case.md", "Run `node scripts/admin-recover.mjs` or `node scripts/admin-recover.mjs.bak`.\n")).toEqual([
      { file: "docs/self-host/case.md", rule: "writing.repository-path", line: 10 },
    ]);
  });

  // A picture's text cannot hold bold, so a UI label it names, kept
  // exactly, reads like a label set in bold.
  it("read a picture's alternative text like bold for the history words and record terms, and as text for the em dash and paths", () => {
    expect(check("docs/self-host/case.md", "![The Services card, its Check now button and the Not now link of a probe](../images/self-host/system.webp)\n")).toEqual([]);
    expect(check("docs/self-host/case.md", "Open the card. ![The card — with src/lib/card.ts](../images/self-host/system.webp)\n")).toEqual([
      { file: "docs/self-host/case.md", rule: "writing.em-dash", line: 10 },
      { file: "docs/self-host/case.md", rule: "writing.repository-path", line: 10 },
    ]);
  });

  it("count the words before a picture inside a paragraph, not the whole paragraph", () => {
    const body = `${w(75)}\n\n${w(70).slice(0, -1)} ![The map](../images/use/map.webp) ${w(9)}\n`;
    expect(check("docs/use/case.md", body)).toEqual([]);
    expect(check("docs/use/case.md", body.replace("![The map](../images/use/map.webp) ", ""))).toEqual([{ file: "docs/use/case.md", rule: "writing.first-screen", line: 12 }]);
  });
});

describe("the names a read_when line is held to", () => {
  const names = writingNames({ catalogue: SETTING_CATALOGUE, document: JSON.parse(readFileSync("docs/api/openapi.json", "utf8")) }) as Names;

  it("are the catalogue's variables, the Settings keys an admin changes, and the description's error codes", () => {
    expect(names.variables).toEqual(expect.arrayContaining(["DEZFIL_DATA_DIR", "DEZFIL_UPLOAD_MAX_MB", "ANTHROPIC_API_KEY", "DEZFIL_AI_PROVIDER"]));
    expect(names.keys).toEqual(expect.arrayContaining(["instanceName", "landingPage", "basemaps.satellite", "templates.catalogue"]));
    expect(names.codes).toEqual(expect.arrayContaining(["upload_too_large", "token_expired", "stale_revision", "rule_refused"]));
  });

  // These two read as ordinary words, so a read_when line names them only
  // when it sets them as code.
  it("include the error codes that are plain words, forbidden and internal, and no others", () => {
    expect(names.codes.filter((code) => /^\p{Ll}+$/u.test(code)).sort()).toEqual(["forbidden", "internal"]);
  });

  it("leave out an account's own preferences, settings no admin changes in Settings, and test wiring", () => {
    expect(names.keys).not.toContain("look.color");
    expect(names.keys).not.toContain("maps.view");
    expect(names.keys).not.toContain("dataDir");
    for (const wiring of TEST_WIRING) expect(names.variables).not.toContain(wiring.environment);
  });
});

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
    ["a file under docs/ that is not a page", "docs/start/install.md\ndocs/README.md\n", 2],
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

  // The command prints each problem as file:line: rule: message, the page
  // contract's form, so every failing product case is run through it too.
  // A fixture tree carries no settings catalogue or API description, so the
  // command has no names for a read_when line; those cases run above with
  // the product section's names.
  const throughCommand = productCases.filter((t) => t.problems.length > 0 && !t.problems.some((p) => p.rule === "writing.read-when-name"));
  it.each(throughCommand)("report every problem with its file, line and rule: $name", ({ files, problems }) => {
    const { code, output } = run(write(productTree(files)));
    expect(code).toBe(1);
    const reported = [...output.matchAll(/^(\S+?):(\d+): ([a-z-]+\.[a-z-]+): \S/gm)].map((m) => ({ file: m[1], rule: m[3], line: Number(m[2]) }));
    expect(reported).toEqual(problems);
    expect(output).toContain(`FAIL: ${problems.length} documentation problem(s).`);
  });

  it("fails a list entry that names no page, with the list's file, line and rule", () => {
    const { code, output } = run(write({ ...cases.base, [WRITING_LIST]: "# Not yet rewritten.\ndocs/start/install.md\ndocs/start/gone.md\n" }));
    expect(output).toMatch(/^scripts\/docs-not-rewritten\.txt:3: writing\.list-entry: /m);
    expect(output).toContain("FAIL: 1 documentation problem(s).");
    expect(code).toBe(1);
  });
});
