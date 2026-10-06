// Both configuration guides cover the catalogue in both directions, including
// documented defaults and change timing. Keep the independent source and script
// scans too: a row in the catalogue cannot justify an unused deployment name.
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
import { pathToFileURL } from "node:url";
import { settingsSource } from "./settings-source.mjs";

const PLATFORM = new Set(["NODE_ENV", "PORT", "HOSTNAME", "NEXT_RUNTIME", "TZ", "CI", "DUCKDB_EXTENSION_DIR"]);
const DOCUMENTED_PLATFORM = new Set([...PLATFORM, "NEXT_TELEMETRY_DISABLED"]);

const EXCLUDED = (name) =>
  name.startsWith("DEZFIL_TEST_") ||
  name === "DEZFIL_BASE_URL" ||
  PLATFORM.has(name);

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

/** Parse table cells by their header, so a lost timing column cannot pass. */
export function configurationRows(text) {
  let header = [];
  const rows = [];
  const normalize = value => value.replaceAll("`", "").replace(/\s+/g, " ").trim();
  for (const line of text.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
    if (/^\|\s*(?:Setting|Variable)\s*\|/.test(line)) header = cells;
    if (!line.startsWith("|")) header = [];
    const match = /^\|\s*`([A-Z][A-Z0-9_]+)`/.exec(line);
    if (match) rows.push({ name: match[1],
      defaultValue: normalize(cells[header.indexOf("Default")] ?? ""),
      changedBy: normalize(cells[header.indexOf("Changed by")] ?? ""),
    });
  }
  return rows;
}

function differences(expected, actual, label) {
  const { undocumented, stale } = judge(expected, actual);
  return [
    ...undocumented.map(name => `UNDOCUMENTED: ${label}: ${name}`),
    ...stale.map(name => `STALE: ${label}: ${name}`),
  ];
}

/** Definitions are supplied by the actual catalogue, never a second defaults map. */
export function catalogueRowProblems(definitions, rows, label) {
  const byName = new Map(definitions.map(definition => [definition.environment, definition]));
  const names = new Set(rows.map(row => row.name));
  const problems = differences(new Set(byName.keys()), names, label);
  for (const name of names) {
    const matches = rows.filter(row => row.name === name);
    if (matches.length !== 1) problems.push(`DUPLICATE: ${label}: ${name}`);
    const definition = byName.get(name);
    if (!definition) continue;
    const changedBy = definition.editable && definition.timing === "live" ? "App (live) or restart" : "Restart";
    for (const row of matches) {
      if (row.defaultValue !== definition.documentedDefault) problems.push(
        `DEFAULT: ${label}: ${name}: expected ${JSON.stringify(definition.documentedDefault)}, found ${JSON.stringify(row.defaultValue)}`,
      );
      if (row.changedBy !== changedBy) problems.push(
        `CHANGED BY: ${label}: ${name}: expected ${JSON.stringify(changedBy)}, found ${JSON.stringify(row.changedBy)}`,
      );
    }
  }
  return problems;
}

export function configurationProblems({ srcDir, documents, catalogue, testWiring }) {
  const definitions = catalogue.filter(definition => definition.environment && definition.scope !== "platform");
  const scriptsDir = path.join(srcDir, "..", "scripts");
  const server = serverVariables(srcDir, scriptsDir);
  const wiring = probeVariables(scriptsDir);
  const problems = differences(new Set([...definitions, ...testWiring].map(d => d.environment)), server, "source scan against catalogue");
  problems.push(...differences(new Set(testWiring.map(d => d.environment)), wiring, "script test wiring against catalogue"));
  for (const [label, text] of Object.entries(documents)) {
    const rows = configurationRows(text).filter(row => !DOCUMENTED_PLATFORM.has(row.name));
    const deploymentRows = rows.filter(row => !row.name.startsWith("DEZFIL_TEST_"));
    const wiringRows = rows.filter(row => row.name.startsWith("DEZFIL_TEST_"));
    problems.push(...catalogueRowProblems(definitions, deploymentRows, label));
    problems.push(...catalogueRowProblems(testWiring, wiringRows, `${label} test wiring`));
    // Retain each document's direct comparison with executable script reads.
    problems.push(...differences(wiring, new Set(wiringRows.map(row => row.name)), `${label} script test wiring`));
  }
  return problems;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const srcDir = argOf("--src", path.join(process.cwd(), "src"));
  const readme = argOf("--readme", path.join(process.cwd(), "README.md"));
  const configuration = argOf("--configuration", path.join(process.cwd(), "docs/configuration.md"));
  const { SETTING_CATALOGUE, TEST_WIRING } = await settingsSource(path.dirname(srcDir));
  const problems = configurationProblems({ srcDir, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING,
    documents: { [readme]: readFileSync(readme, "utf8"), [configuration]: readFileSync(configuration, "utf8") },
  });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} configuration discrepancies.`);
    process.exitCode = 1;
  } else {
    const deployment = SETTING_CATALOGUE.filter(d => d.environment && d.scope !== "platform").length;
    console.log(`PASS: both documents match ${deployment} deployment settings and ${TEST_WIRING.length} test-wiring names, defaults and change timing; source scans agree in both directions.`);
  }
}
