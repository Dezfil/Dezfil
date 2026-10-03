// The README documents the full configuration surface:
// every environment variable the server reads as a deployment setting —
// DEZFIL_* and the provider keys alike — appears in
// the README's configuration table, and every table row names a variable
// the server actually reads — both directions, so the surface and its
// documentation cannot silently drift apart again.
//
// Coverage is defined by what `src` reads from process.env, minus two
// documented exclusion classes:
//   - source-local test wiring: DEZFIL_TEST_* (tiler stubs, fixture URLs) and
//     DEZFIL_BASE_URL (the Playwright runner's target, read by e2e
//     tooling, never by the server);
//   - platform/image plumbing that is not an operator tunable: NODE_ENV,
//     PORT, HOSTNAME, NEXT_RUNTIME (runtime-provided), and
//     DUCKDB_EXTENSION_DIR (set by the Dockerfile to the baked bundle;
//     overriding it defeats the offline guarantee).
// Script DEZFIL_TEST_* reads are documented too: the image observers are
// part of the reproducible operator recipes.
// Anything else the server reads — today that includes ANTHROPIC_API_KEY
// and OPENAI_API_KEY — must be documented.
//
// Usage: node scripts/check-readme-config.mjs [--src DIR] [--readme FILE] [--configuration FILE]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/** Test-only environment reads in executable probe helpers, not mentions. */
export function probeVariables(scriptsDir) {
  const names = new Set();
  if (!existsSync(scriptsDir)) return names;
  for (const file of walk(scriptsDir).filter(file => /\.[cm]?js$/.test(file))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [/process\.env\.(DEZFIL_TEST_[A-Z0-9_]+)/g, /process\.env\[["'](DEZFIL_TEST_[A-Z0-9_]+)["']\]/g]) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

/** Every operator-facing name the server code reads (src, excluding
 * tests). Three extractions, because the code reads settings three ways:
 * DEZFIL_* tokens in any context (the limits helpers take the name as
 * a string), *_API_KEY tokens in any context (the provider keys travel
 * through a name map), and direct process.env accesses for anything
 * else — minus the documented exclusions. */
export function serverVariables(srcDir, scriptsDir = path.join(srcDir, "..", "scripts")) {
  const names = probeVariables(scriptsDir);
  const files = walk(srcDir).filter(
    (f) =>
      /\.(?:ts|tsx|js|mjs)$/.test(f) && !/\.test\.(?:ts|tsx|js|mjs)$/.test(f),
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
        // The guide names this client-side reference. A real process.env
        // read still counts through the direct-access patterns below.
        if (pattern === patterns[0] && m[1] === "DEZFIL_API_TOKEN") continue;
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
  const configuration = argOf("--configuration", path.join(process.cwd(), "docs/configuration.md"));
  const wiring = probeVariables(path.join(srcDir, "..", "scripts"));
  const documentedWiring = new Set([...documentedVariables(configuration)].filter(name => name.startsWith("DEZFIL_TEST_")));
  const drift = judge(wiring, documentedWiring);
  for (const name of drift.undocumented) undocumented.push(`${name} (docs/configuration.md)`);
  for (const name of drift.stale) stale.push(`${name} (docs/configuration.md)`);
  for (const n of undocumented) {
    console.error(`UNDOCUMENTED: code reads ${n} — add it to the configuration table`);
  }
  for (const n of stale) {
    console.error(`STALE: configuration documents ${n} — code no longer reads it`);
  }
  if (undocumented.length + stale.length > 0) {
    console.error(
      `FAIL — ${undocumented.length} undocumented, ${stale.length} stale.`,
    );
    process.exit(1);
  }
  console.log("PASS — configuration covers server settings and script test wiring, both directions.");
}
