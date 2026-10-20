// The configuration-coverage check must be demonstrably red in both directions
// — an undocumented server setting and a stale documented one — and
// green on the real repository. A check that cannot be shown red is not
// evidence.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SETTING_CATALOGUE } from "./settings/catalogue";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import {
  serverVariables,
  documentedVariables,
  judge,
  linkedPages,
} from "../../scripts/check-readme-config.mjs";

const dir = mkdtempSync(join(tmpdir(), "dezfil-readme-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(code: string, page: string) {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "config.ts"), code);
  const pagePath = join(src, "configuration.md");
  writeFileSync(pagePath, page);
  return judge(serverVariables(src), documentedVariables(pagePath));
}

/** A page holding a settings table with these variables, and a plain table
 * beside it that the check does not read. */
const TABLE = (variables: string[], plain: string[] = []) => [
  "<!-- settings-storage:start -->",
  "",
  "| Setting | Variable | Settings key | Default | Values | What it does | Changes |",
  "|---|---|---|---|---|---|---|",
  ...variables.map(name => `| **Setting** | \`${name}\` |  | unset | Any | Does. | By variable, after a restart |`),
  "",
  "<!-- settings-storage:end -->",
  "",
  "| Variable | Where it is set | Effect |",
  "|---|---|---|",
  ...plain,
].join("\n");
/** A page holding the test wiring's table with these variables. */
const WIRING = (variables: string[]) => [
  "<!-- test-wiring:start -->",
  "",
  "| Variable | Default | What it does |",
  "|---|---|---|",
  ...variables.map(name => `| \`${name}\` | unset | Seam. |`),
  "",
  "<!-- test-wiring:end -->",
].join("\n");

describe("configuration page coverage", () => {
  it("excludes client token reference text but still detects a server read", () => {
    expect(fixture('export const guide = "DEZFIL_API_TOKEN";', TABLE([]))).toEqual({ undocumented: [], stale: [] });
    expect(fixture('export const token = process.env.DEZFIL_API_TOKEN;', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
    expect(fixture('export const token = process.env["DEZFIL_API_TOKEN"];', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
  });
  it("red on a server setting the settings tables do not document", () => {
    const { undocumented, stale } = fixture(
      'export const x = process.env.DEZFIL_FAKE_SETTING;',
      TABLE(["DEZFIL_DATA_DIR"]),
    );
    expect(undocumented).toEqual(["DEZFIL_FAKE_SETTING"]);
    expect(stale).toEqual(["DEZFIL_DATA_DIR"]);
  });

  it("green when the table matches the surface; exclusions hold", () => {
    const { undocumented, stale } = fixture(
      [
        'export const a = process.env.DEZFIL_DATA_DIR;',
        'export const b = "DEZFIL_TEST_TILER_LOG";', // a mention, not a read: excluded
        'export const c = process.env.DEZFIL_BASE_URL;', // excluded
        'export const d = process.env.NODE_ENV;', // platform, excluded
        'export const e = process.env.DUCKDB_EXTENSION_DIR;', // plumbing
        'export const f = process.env.PATH;', // platform, excluded
      ].join("\n"),
      TABLE(["DEZFIL_DATA_DIR"]),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("red on a test seam the server code reads that the wiring table does not document, and stale once it is no longer read", () => {
    expect(fixture('export const r = process.env.DEZFIL_TEST_ENGINE_SEAM;', WIRING([])).undocumented).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
    expect(fixture('export const r = process.env["DEZFIL_TEST_ENGINE_SEAM"];', WIRING([])).undocumented).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
    expect(fixture('export const r = "no seam";', WIRING(["DEZFIL_TEST_ENGINE_SEAM"])).stale).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
  });

  it("leaves a test seam that only a test file reads to that file", () => {
    const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "engine.test.ts"), "export const local = process.env.DEZFIL_TEST_FILE_LOCAL;");
    expect([...serverVariables(src)]).toEqual([]);
  });

  it("reads the generated tables alone: platform rows a page lists by name, and a row outside a table's markers, are not documented settings", () => {
    const { undocumented, stale } = fixture(
      'export const a = process.env.DEZFIL_DATA_DIR;',
      TABLE(["DEZFIL_DATA_DIR"], ["| `PORT` | image sets `3000` | Port. |", "| `NEXT_TELEMETRY_DISABLED` | image sets `1` | Telemetry. |", "| `DEZFIL_OUTSIDE` | unset | Outside. |"]),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("red on an undocumented non-DEZFIL administrator setting", () => {
    const { undocumented } = fixture(
      'export const k = process.env.SOME_PROVIDER_API_KEY;',
      TABLE(["SOME_OTHER_ROW"]),
    );
    expect(undocumented).toEqual(["SOME_PROVIDER_API_KEY"]);
  });

  it("red when a documented provider-key row is deleted", () => {
    const { undocumented } = fixture(
      'export const k = process.env.ANTHROPIC_API_KEY;',
      TABLE(["DEZFIL_DATA_DIR"]),
    );
    expect(undocumented).toContain("ANTHROPIC_API_KEY");
  });

  it("green on the real repository, both directions — provider keys covered", () => {
    const { server, documented } = real();
    expect([...server]).toContain("ANTHROPIC_API_KEY");
    expect([...server]).toContain("OPENAI_API_KEY");
    const { undocumented, stale } = judge(server, documented);
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });
});

/** What the server reads and what the tables the configuration overview
 * links, with the test wiring's on Development setup, document. */
function real() {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const documents = Object.fromEntries(readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".md")).map(file => [`docs/${file.split("\\").join("/")}`, readFileSync(join(root, "docs", file), "utf8")]));
  const pages: string[] = [...new Set([...linkedPages(documents), "docs/contribute/development-setup.md"])];
  return { server: serverVariables(join(root, "src"), join(root, "scripts"), [...SETTING_CATALOGUE]) as Set<string>, documented: documentedVariables(...pages.map(page => join(root, page))) as Set<string> };
}

it("includes the image observers' test settings in the wiring table", () => {
  const { server: actual, documented } = real();
  const names = ["DEZFIL_TEST_PUBLICATION_LOG", "DEZFIL_TEST_DERIVATION_LOG"];
  for (const name of names) {
    expect(actual.has(name), name).toBe(true);
    expect(documented.has(name), name).toBe(true);
  }
  for (const name of names) {
    const dropped = new Set(documented); dropped.delete(name);
    expect(judge(actual, dropped).undocumented).toContain(name);
    const stopped = new Set(actual); stopped.delete(name);
    expect(judge(stopped, documented).stale).toContain(name);
  }
});


/** A source tree of these files, keyed by their path under src/. */
function tree(files: Record<string, string>): string {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(src, file, ".."), { recursive: true });
    writeFileSync(join(src, file), text);
  }
  return src;
}

describe("what the code reads of the catalogue", () => {
  const none = join(dir, "no-scripts");
  const catalogue = [
    { key: "usedMb", environment: "DEZFIL_USED_MB" }, { key: "unusedMb", environment: "DEZFIL_UNUSED_MB" },
    { key: "mistralApiKey", environment: "MISTRAL_API_KEY" }, { key: "seamEndpoint", environment: "DEZFIL_SEAM_ENDPOINT" },
  ];

  it("counts a setting the code resolves by its key, or names outside the catalogue, and not one only the catalogue's own definitions name", () => {
    const src = tree({
      "lib/settings/numeric.ts": 'numeric("usedMb", "DEZFIL_USED_MB"); numeric("unusedMb", "DEZFIL_UNUSED_MB");',
      "lib/settings/catalogue.ts": 'deployment("mistralApiKey", "MISTRAL_API_KEY"); deployment("seamEndpoint", "DEZFIL_SEAM_ENDPOINT");',
      "lib/limits.ts": 'export const used = () => resolveNumber("usedMb");',
      "lib/overture.ts": "export const seam = () => process.env.DEZFIL_SEAM_ENDPOINT;",
    });
    expect([...serverVariables(src, none, catalogue)].sort()).toEqual(["DEZFIL_SEAM_ENDPOINT", "DEZFIL_USED_MB"]);
  });

  it("counts no name a comment alone holds", () => {
    const src = tree({
      "lib/settings/catalogue.ts": 'deployment("seamEndpoint", "DEZFIL_SEAM_ENDPOINT");',
      "lib/overture.ts": [
        "// DEZFIL_SEAM_ENDPOINT (a test seam) was read here.",
        "/** resolveNumber(\"unusedMb\") and MISTRAL_API_KEY, in a comment. */",
        'export const site = "https://example.org/"; // DEZFIL_UNUSED_MB',
      ].join("\n"),
    });
    expect([...serverVariables(src, none, catalogue)]).toEqual([]);
  });

  it("still reads a name a string holds, past a URL and a regular expression with quotes in it", () => {
    const src = tree({ "lib/a.ts": 'const host = "https://x.example"; const quote = /["\']/; export const k = process.env.DEZFIL_AFTER_THEM;' });
    expect([...serverVariables(src, none, catalogue)]).toEqual(["DEZFIL_AFTER_THEM"]);
  });
});

it("discovers new script test wiring and its removal without counting mentions", () => {
  const scripts = join(dir, "scripts"); mkdirSync(scripts);
  const file = join(scripts, "observer.mjs");
  writeFileSync(file, 'const a = process.env.DEZFIL_TEST_NEW_OBSERVER; const b = process.env["DEZFIL_TEST_QUOTED"];');
  const src = join(dir, "empty-src"); mkdirSync(src);
  expect([...serverVariables(src, scripts)].sort()).toEqual(["DEZFIL_TEST_NEW_OBSERVER", "DEZFIL_TEST_QUOTED"]);
  writeFileSync(file, 'const message = "DEZFIL_TEST_NEW_OBSERVER is no longer read";');
  expect([...serverVariables(src, scripts)]).toEqual([]);
});
