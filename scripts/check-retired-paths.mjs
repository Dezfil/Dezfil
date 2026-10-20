#!/usr/bin/env node
// No tracked file names a documentation path that no longer exists.
//
// The documentation moved into six reader sections, and its verification
// procedures moved out of it, beside the scripts they run. A comment, a
// test, a link in the app or a string in the API description that still
// names an old path sends its reader nowhere, and nothing else fails on it:
// the page contract reads only the pages, and a path in a comment resolves
// to nothing without anyone noticing. This check reads the whole tracked
// tree for the finite list below.
//
// What counts as naming one: an old page or folder written as a repository
// path from `docs/`, as a site address under https://dezfil.io/docs/, as an
// address in this repository on GitHub, or as a relative link between
// pages. A path inside an address on another site is that site's own path
// and is not read.
//
// The exceptions, each one line and never the rest of its file:
// - the list itself, between the markers below;
// - a page's `moved_from` rows, the old addresses the site redirects;
// - a test fixture that shows a retired path is refused: in a test file,
//   a line marked with the words "retired-path fixture"; in a fixture file
//   that cannot carry a comment, a line named in FIXTURE_LINES.
//
// Usage:
//   node scripts/check-retired-paths.mjs            # all tracked files
//   node scripts/check-retired-paths.mjs <file...>  # exactly these

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIST_FILE = "scripts/check-retired-paths.mjs";
const BEGIN = "retired-paths:begin";
const END = "retired-paths:end";

// retired-paths:begin
/** Old pages and files, named by their path under a section folder. */
export const RETIRED_PATHS = [
  "start/run-it",
  "guides/templates",
  "reference/http-api",
  "reference/mcp",
  "reference/configuration",
  "reference/sql-limits",
  "reference/api",
  "reference/openapi.json",
  "operate/self-hosting",
  "operate/runbook",
  "develop/architecture",
  "develop/checks-and-testing",
  "develop/how-this-is-built",
  "develop/contributing",
  "develop/code-of-conduct",
  "develop/verification",
  "images/guides",
  "self-host/all-settings",
  "self-host/runbook",
  "self-host/self-hosting",
  "use/sql-limits",
  "contribute/checks-and-testing",
];
/** Old section folders, retired whole, named from the repository root. */
export const RETIRED_FOLDERS = [
  "docs/guides",
  "docs/reference",
  "docs/operate",
  "docs/develop",
];
/** Fixture lines in files that cannot carry a comment: the file, and a
 * piece of the line. */
export const FIXTURE_LINES = [
  ["test-support/docs-contract/cases.json", "\"docs/reference/case.md\""],
];
// retired-paths:end

const FIXTURE_MARK = "retired-path fixture";
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "woff", "woff2", "pmtiles",
  "parquet", "sqlite", "duckdb", "zip", "gz", "webm",
]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An entry is found only as whole segments: it starts after anything that
// cannot be part of a segment and ends before the same, so it is not found
// inside a longer name that adds a prefix or a hyphenated suffix.
const ENTRY = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${[...RETIRED_FOLDERS, ...RETIRED_PATHS].map(escape).join("|")})(?![A-Za-z0-9_-])`,
  "g",
);
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`[\]{}]+/gi;

/** Whether an address belongs to this project: the documentation site or
 * the repository itself. A retired path in any other site's address is that
 * site's own. */
function ours(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "dezfil.io" || parsed.hostname.endsWith(".dezfil.io")) return true;
    return parsed.hostname.endsWith("github.com") || parsed.hostname.endsWith("githubusercontent.com")
      ? /^\/Dezfil\/Dezfil(?:\/|$)/i.test(parsed.pathname)
      : false;
  } catch {
    return true;
  }
}

const isTest = (file) => /\.test\.[cm]?[jt]sx?$/.test(file) || file.startsWith("test-support/") || file.startsWith("e2e/");

/** The lines of one file the exceptions cover, by index. */
function exemptLines(file, lines) {
  const exempt = new Set();
  if (file === LIST_FILE) {
    const begin = lines.findIndex((line) => line.trim() === `// ${BEGIN}`);
    const end = lines.findIndex((line) => line.trim() === `// ${END}`);
    if (begin !== -1 && end > begin) for (let i = begin + 1; i < end; i += 1) exempt.add(i);
  }
  if (/^docs\/.+\.md$/.test(file) && lines[0] === "---") {
    let inMoved = false;
    for (let i = 1; i < lines.length && lines[i] !== "---"; i += 1) {
      if (/^moved_from:\s*$/.test(lines[i])) { inMoved = true; continue; }
      if (inMoved && /^\s+- "\/docs\/[^"]+"\s*$/.test(lines[i])) { exempt.add(i); continue; }
      inMoved = false;
    }
  }
  if (isTest(file)) lines.forEach((line, i) => { if (line.includes(FIXTURE_MARK)) exempt.add(i); });
  for (const [where, piece] of FIXTURE_LINES) {
    if (where === file) lines.forEach((line, i) => { if (line.includes(piece)) exempt.add(i); });
  }
  return exempt;
}

/** Every retired path one text names, with its line, outside the
 * exceptions. */
export function retiredPathsIn(file, text) {
  const lines = text.split("\n");
  const exempt = exemptLines(file, lines);
  const found = [];
  lines.forEach((line, i) => {
    if (exempt.has(i)) return;
    const foreign = [...line.matchAll(URL_RE)].filter((m) => !ours(m[0])).map((m) => [m.index, m.index + m[0].length]);
    for (const hit of line.matchAll(ENTRY)) {
      if (foreign.some(([from, to]) => hit.index >= from && hit.index < to)) continue;
      found.push({ file, line: i + 1, path: hit[0] });
    }
  });
  return found;
}

/** Every retired path the given files name. */
export function findRetiredPaths({ files, read }) {
  return files.flatMap((file) => {
    const dot = file.lastIndexOf(".");
    if (dot !== -1 && BINARY_EXTENSIONS.has(file.slice(dot + 1).toLowerCase())) return [];
    let text;
    try { text = read(file); } catch { return []; }
    return text.includes("\0") ? [] : retiredPathsIn(file, text);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const explicit = process.argv.slice(2);
  const files = explicit.length
    ? explicit
    : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const found = findRetiredPaths({ files, read: (file) => readFileSync(file, "utf8") });
  if (found.length) {
    for (const hit of found) console.error(`${hit.file}:${hit.line} names a retired documentation path: "${hit.path}"`);
    console.error(`FAIL: ${found.length} retired documentation path(s). Name the page where it now lives.`);
    process.exit(1);
  }
  console.log(`PASS: no retired documentation path across ${files.length} file(s).`);
}
