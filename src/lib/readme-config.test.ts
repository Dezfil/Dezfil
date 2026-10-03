// The README-coverage check must be demonstrably red in both directions
// — an undocumented server setting and a stale documented one — and
// green on the real repository. A check that cannot be shown red is not
// evidence.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import {
  serverVariables,
  documentedVariables,
  judge,
} from "../../scripts/check-readme-config.mjs";

const dir = mkdtempSync(join(tmpdir(), "dezfil-readme-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(code: string, readme: string) {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "config.ts"), code);
  const readmePath = join(src, "README.md");
  writeFileSync(readmePath, readme);
  return judge(serverVariables(src), documentedVariables(readmePath));
}

const TABLE = (rows: string[]) =>
  ["| Setting | Default | What |", "|---|---|---|", ...rows].join("\n");

describe("README config coverage", () => {
  it("excludes client token reference text but still detects a server read", () => {
    expect(fixture('export const guide = "DEZFIL_API_TOKEN";', TABLE([]))).toEqual({ undocumented: [], stale: [] });
    expect(fixture('export const token = process.env.DEZFIL_API_TOKEN;', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
    expect(fixture('export const token = process.env["DEZFIL_API_TOKEN"];', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
  });
  it("red on a server setting the README does not document", () => {
    const { undocumented, stale } = fixture(
      'export const x = process.env.DEZFIL_FAKE_SETTING;',
      TABLE(["| `DEZFIL_DATA_DIR` | `/data` | Data. |"]),
    );
    expect(undocumented).toEqual(["DEZFIL_FAKE_SETTING"]);
    expect(stale).toEqual(["DEZFIL_DATA_DIR"]);
  });

  it("green when the table matches the surface; exclusions hold", () => {
    const { undocumented, stale } = fixture(
      [
        'export const a = process.env.DEZFIL_DATA_DIR;',
        'export const b = process.env.DEZFIL_TEST_TILER_LOG;', // excluded
        'export const c = process.env.DEZFIL_BASE_URL;', // excluded
        'export const d = process.env.NODE_ENV;', // platform, excluded
        'export const e = process.env.DUCKDB_EXTENSION_DIR;', // plumbing
      ].join("\n"),
      TABLE(["| `DEZFIL_DATA_DIR` | `/data` | Data. |"]),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("red on an undocumented non-DEZFIL administrator setting", () => {
    const { undocumented } = fixture(
      'export const k = process.env.SOME_PROVIDER_API_KEY;',
      TABLE(["| `SOME_OTHER_ROW` | — | Not it. |"]),
    );
    expect(undocumented).toEqual(["SOME_PROVIDER_API_KEY"]);
  });

  it("red when a documented provider-key row is deleted", () => {
    const { undocumented } = fixture(
      'export const k = process.env.ANTHROPIC_API_KEY;',
      TABLE(["| `DEZFIL_DATA_DIR` | `/data` | Data. |"]),
    );
    expect(undocumented).toContain("ANTHROPIC_API_KEY");
  });

  it("green on the real repository, both directions — provider keys covered", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const server = serverVariables(join(root, "src"));
    expect([...server]).toContain("ANTHROPIC_API_KEY");
    expect([...server]).toContain("OPENAI_API_KEY");
    const { undocumented, stale } = judge(
      server,
      documentedVariables(join(root, "README.md")),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });
});

it("includes the image observers' test settings in both configuration guides", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const actual = serverVariables(join(root, "src"));
  const names = ["DEZFIL_TEST_PUBLICATION_LOG", "DEZFIL_TEST_DERIVATION_LOG"];
  for (const name of names) {
    expect(actual.has(name), name).toBe(true);
    for (const guide of ["README.md", "docs/configuration.md"]) expect(documentedVariables(join(root, guide)).has(name), `${guide}: ${name}`).toBe(true);
  }
  for (const name of names) {
    const dropped = documentedVariables(join(root, "README.md")); dropped.delete(name);
    expect(judge(actual, dropped).undocumented).toContain(name);
    const stopped = new Set(actual); stopped.delete(name);
    expect(judge(stopped, documentedVariables(join(root, "README.md"))).stale).toContain(name);
  }
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
