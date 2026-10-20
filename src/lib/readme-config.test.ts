// The configuration-coverage check must be demonstrably red in both directions
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

function fixture(code: string, page: string) {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "config.ts"), code);
  const pagePath = join(src, "configuration.md");
  writeFileSync(pagePath, page);
  return judge(serverVariables(src), documentedVariables(pagePath));
}

const TABLE = (rows: string[]) =>
  ["| Setting | Default | What |", "|---|---|---|", ...rows].join("\n");

describe("configuration page coverage", () => {
  it("excludes client token reference text but still detects a server read", () => {
    expect(fixture('export const guide = "DEZFIL_API_TOKEN";', TABLE([]))).toEqual({ undocumented: [], stale: [] });
    expect(fixture('export const token = process.env.DEZFIL_API_TOKEN;', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
    expect(fixture('export const token = process.env["DEZFIL_API_TOKEN"];', TABLE([])).undocumented).toEqual(['DEZFIL_API_TOKEN']);
  });
  it("red on a server setting the configuration page does not document", () => {
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
        'export const b = "DEZFIL_TEST_TILER_LOG";', // a mention, not a read: excluded
        'export const c = process.env.DEZFIL_BASE_URL;', // excluded
        'export const d = process.env.NODE_ENV;', // platform, excluded
        'export const e = process.env.DUCKDB_EXTENSION_DIR;', // plumbing
        'export const f = process.env.PATH;', // platform, excluded
      ].join("\n"),
      TABLE(["| `DEZFIL_DATA_DIR` | `/data` | Data. |"]),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("red on a test seam the server code reads that the configuration page does not document, and stale once it is no longer read", () => {
    expect(fixture('export const r = process.env.DEZFIL_TEST_ENGINE_SEAM;', TABLE([])).undocumented).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
    expect(fixture('export const r = process.env["DEZFIL_TEST_ENGINE_SEAM"];', TABLE([])).undocumented).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
    expect(fixture('export const r = "no seam";', TABLE(["| `DEZFIL_TEST_ENGINE_SEAM` | unset | Seam. |"])).stale).toEqual(["DEZFIL_TEST_ENGINE_SEAM"]);
  });

  it("leaves a test seam that only a test file reads to that file", () => {
    const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "engine.test.ts"), "export const local = process.env.DEZFIL_TEST_FILE_LOCAL;");
    expect([...serverVariables(src)]).toEqual([]);
  });

  it("leaves the platform rows the page lists by name out of the documented set", () => {
    const { undocumented, stale } = fixture(
      'export const a = process.env.DEZFIL_DATA_DIR;',
      TABLE(["| `DEZFIL_DATA_DIR` | `/data` | Data. |", "| `PORT` | image sets `3000` | Port. |", "| `NEXT_TELEMETRY_DISABLED` | image sets `1` | Telemetry. |"]),
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
      documentedVariables(join(root, "docs/self-host/configuration.md")),
    );
    expect(undocumented).toEqual([]);
    expect(stale).toEqual([]);
  });
});

it("includes the image observers' test settings on the configuration page", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const actual = serverVariables(join(root, "src"));
  const names = ["DEZFIL_TEST_PUBLICATION_LOG", "DEZFIL_TEST_DERIVATION_LOG"];
  for (const name of names) {
    expect(actual.has(name), name).toBe(true);
    expect(documentedVariables(join(root, "docs/self-host/configuration.md")).has(name), name).toBe(true);
  }
  for (const name of names) {
    const dropped = documentedVariables(join(root, "docs/self-host/configuration.md")); dropped.delete(name);
    expect(judge(actual, dropped).undocumented).toContain(name);
    const stopped = new Set(actual); stopped.delete(name);
    expect(judge(stopped, documentedVariables(join(root, "docs/self-host/configuration.md"))).stale).toContain(name);
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
