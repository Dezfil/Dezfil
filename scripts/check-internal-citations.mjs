#!/usr/bin/env node
// Source hygiene: no tracked file may cite a document this repository does
// not carry.
//
// Why this exists: the published tree was assembled from a private history
// whose planning documents, tracking rows and design folders are not part of
// it. Two guards already existed and neither could see this class — the
// commit-message guard reads commit messages, and the served-contract guard
// reads API descriptions. Four tracking rows still reached the tree inside
// report labels in scripts/perf, because every manual sweep was scoped to a
// list of directories and searched for a capitalised product name. This check
// reads the whole tracked tree instead, so the class cannot return through a
// file nobody thought to name.
//
// Usage:
//   node scripts/check-internal-citations.mjs            # all tracked files
//   node scripts/check-internal-citations.mjs <file...>  # exactly these
//
// Note on \b: a tracking row written inside a string literal as "\nN-19" is
// preceded by the "n" of the escape, so a leading word boundary would not
// match the source text even though it matches at runtime. These patterns
// deliberately carry no leading \b.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { re: /spec [0-9]{4}/g, what: "a planning-document number" },
  { re: /N-[0-9]+/g, what: "a tracking row" },
  { re: /(?:sdd|research)\/[\w./-]+/g, what: "a folder the repository drops" },
  { re: /docs\/(?:phases|known-issues|assessments)/g, what: "a dropped record path" },
  { re: /design\/prototypes/g, what: "a dropped design folder" },
  { re: /[Pp]hase [0-9]+(?:\.[0-9]+)?/g, what: "a phase of the private history" },
  { re: /phase-[0-9]+(?:\.[0-9]+)?/g, what: "a phase folder" },
  // The private review record's own files. A public description of how a
  // change is reviewed stays allowed: these are the shapes of the record's
  // files and folder, never the words "review" or "round" in prose.
  { re: /reviews\/[\w./-]*/g, what: "a review record folder" },
  { re: /[\w.-]*findings\.md/g, what: "a review findings file" },
  { re: /[\w.-]*reconciliation\.md/g, what: "a review reconciliation" },
  { re: /[\w.-]*(?<![A-Za-z])(?:review|codex)[\w.-]*\.log(?:\.gz)?/g, what: "a review log" },
];

// The two guards must hold these shapes as pattern literals: rejecting a
// citation means spelling out what a citation looks like. Nothing else is
// exempt.
const ALLOWLIST = new Set([
  ".github/scripts/check-commit-messages.mjs",
  "scripts/check-internal-citations.mjs",
  "src/lib/api/openapi-exposure.test.ts",
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "woff", "woff2", "pmtiles",
  "parquet", "sqlite", "duckdb", "zip", "gz", "webm",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function isBinary(path) {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

const explicit = process.argv.slice(2);
const files = explicit.length
  ? explicit
  : trackedFiles().filter((f) => !isBinary(f) && !ALLOWLIST.has(f));

const offenders = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted-but-still-listed, or not decodable as text
  }
  const lines = text.split("\n");
  for (const { re, what } of PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      for (const hit of lines[i].matchAll(re)) {
        offenders.push({ file, line: i + 1, what, text: hit[0] });
      }
    }
  }
}

if (offenders.length) {
  for (const o of offenders) {
    console.error(`${o.file}:${o.line} cites ${o.what}: "${o.text}"`);
  }
  console.error(
    `FAIL — ${offenders.length} citation(s) of documents this repository does not carry.`,
  );
  process.exit(1);
}

console.log(
  `PASS — no internal citations across ${files.length} scanned file(s).`,
);
