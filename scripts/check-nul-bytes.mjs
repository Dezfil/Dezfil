#!/usr/bin/env node
// Source hygiene: no tracked text file may contain a NUL byte (0x00).
//
// Why this exists: a single literal NUL inside
// src/components/builder/SqlDock.tsx made git and grep treat the file as
// binary — it silently vanished from text searches, reviewable diffs, and
// the grep-driven audits the defect registry is built on. The fix removed
// the byte; this check keeps the class out.
//
// Usage:
//   node scripts/check-nul-bytes.mjs            # scan all git-tracked files
//   node scripts/check-nul-bytes.mjs <file...>  # scan exactly these files
//
// Files whose extension is on the binary allowlist (real image assets) are
// skipped in tracked-files mode; explicitly named files are always scanned.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Formats that are binary by nature. Everything else tracked in this repo
// is text and must stay greppable.
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "woff",
  "woff2",
  // The shipped templates' datasets (templates/) are GeoParquet files.
  "parquet",
]);

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function isAllowlistedBinary(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

const explicit = process.argv.slice(2);
const files = explicit.length
  ? explicit
  : trackedFiles().filter((f) => !isAllowlistedBinary(f));

const offenders = [];
for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue; // deleted-but-still-listed; nothing to scan
  }
  const at = buf.indexOf(0);
  if (at !== -1) offenders.push({ file: f, offset: at });
}

if (offenders.length) {
  for (const { file, offset } of offenders) {
    console.error(
      `NUL byte at offset ${offset} in ${file} — git and grep will treat this file as binary`,
    );
  }
  console.error(`FAIL — ${offenders.length} file(s) contain NUL bytes.`);
  process.exit(1);
}

console.log(`PASS — no NUL bytes across ${files.length} scanned file(s).`);
