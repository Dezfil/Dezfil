// The README documents the full configuration surface:
// every environment variable the server reads as a deployment setting —
// DEZFIL_* and the provider keys alike — appears in
// the README's configuration table, and every table row names a variable
// the server actually reads — both directions, so the surface and its
// documentation cannot silently drift apart again.
//
// Coverage is defined by what `src` reads from process.env, minus two
// documented exclusion classes:
//   - test wiring: DEZFIL_TEST_* (tiler stubs, fixture URLs) and
//     DEZFIL_BASE_URL (the Playwright runner's target, read by e2e
//     tooling, never by the server);
//   - platform/image plumbing that is not an operator tunable: NODE_ENV,
//     PORT, HOSTNAME, NEXT_RUNTIME (runtime-provided), and
//     DUCKDB_EXTENSION_DIR (set by the Dockerfile to the baked bundle;
//     overriding it defeats the offline guarantee).
// Anything else the server reads — today that includes ANTHROPIC_API_KEY
// and OPENAI_API_KEY — must be documented.
//
// Usage: node scripts/check-readme-config.mjs [--src DIR] [--readme FILE]
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const EXCLUDED = (name) =>
  name.startsWith("DEZFIL_TEST_") ||
  name === "DEZFIL_BASE_URL" ||
  ["NODE_ENV", "PORT", "HOSTNAME", "NEXT_RUNTIME", "TZ", "CI"].includes(
    name,
  ) ||
  name === "DUCKDB_EXTENSION_DIR";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every operator-facing name the server code reads (src, excluding
 * tests). Three extractions, because the code reads settings three ways:
 * DEZFIL_* tokens in any context (the limits helpers take the name as
 * a string), *_API_KEY tokens in any context (the provider keys travel
 * through a name map), and direct process.env accesses for anything
 * else — minus the documented exclusions. */
export function serverVariables(srcDir) {
  const names = new Set();
  const files = walk(srcDir).filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"),
  );
  const patterns = [
    /\b(DEZFIL_[A-Z0-9_]+)\b/g,
    /\b([A-Z][A-Z0-9_]*_API_KEY)\b/g,
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const m of src.matchAll(pattern)) {
        if (!EXCLUDED(m[1])) names.add(m[1]);
      }
    }
  }
  return names;
}

/** Every variable the README's configuration table documents. */
export function documentedVariables(readmeFile) {
  const names = new Set();
  for (const line of readFileSync(readmeFile, "utf8").split("\n")) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

export function judge(server, documented) {
  const undocumented = [...server].filter((n) => !documented.has(n)).sort();
  const stale = [...documented].filter((n) => !server.has(n)).sort();
  return { undocumented, stale };
}

const isMain = process.argv[1]?.endsWith("check-readme-config.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const srcDir = argOf("--src", path.join(process.cwd(), "src"));
  const readme = argOf("--readme", path.join(process.cwd(), "README.md"));
  const { undocumented, stale } = judge(
    serverVariables(srcDir),
    documentedVariables(readme),
  );
  for (const n of undocumented) {
    console.error(`UNDOCUMENTED: the server reads ${n} — add it to the README configuration table`);
  }
  for (const n of stale) {
    console.error(`STALE: the README documents ${n} — the server no longer reads it`);
  }
  if (undocumented.length + stale.length > 0) {
    console.error(
      `FAIL — ${undocumented.length} undocumented, ${stale.length} stale.`,
    );
    process.exit(1);
  }
  console.log("PASS — the README covers the configuration surface, both directions.");
}
