// Both configuration guides cover the catalogue in both directions, including
// documented defaults and change timing. Keep the independent source and script
// scans too: a row in the catalogue cannot justify an unused deployment name.
//
// Coverage is defined by what `src` reads from process.env, minus two
// documented exclusion classes:
//   - test-local wiring: DEZFIL_TEST_* named anywhere but a read in the
//     server code (tiler stubs and fixture URLs read by test files, the
//     names the catalogue lists) and DEZFIL_BASE_URL (the Playwright
//     runner's target, read by e2e tooling, never by the server);
//   - platform/image plumbing that is not an operator tunable: NODE_ENV,
//     PORT, HOSTNAME, NEXT_RUNTIME (runtime-provided), PATH (the system's
//     program search path, read to find a configured program given by
//     name), DUCKDB_EXTENSION_DIR (set by the Dockerfile to the baked
//     bundle; overriding it defeats the offline guarantee) and
//     UV_THREADPOOL_SIZE (the runtime's own worker pool size, which the
//     runtime reads; the server reads it only to size the share PostGIS
//     source calls may take).
// Script DEZFIL_TEST_* reads are documented too: the image observers are
// part of the reproducible operator recipes. So is a DEZFIL_TEST_* seam the
// server code itself reads (process.env, outside test files): it is test
// wiring in the product, and both guides name it.
// Anything else the server reads — today that includes ANTHROPIC_API_KEY
// and OPENAI_API_KEY — must be documented.
//
// The configuration guide's Instance defaults table is held to the
// catalogue's defaults, what new things start with (settings every
// signed-in account reads, in the defaults' groups, as the catalogue's own
// predicate says), in both directions and by documented default. They have
// no variable, so their rows name the key the change operation takes. Its
// Security and rules table is held the same way to the catalogue's rules
// (stored sign-in, token, publishing, connection and import settings, as
// the catalogue's own predicate says), its Libraries table to the
// basemap switches (which styles are offered, and whether a single map may
// take a style address of its own, as the catalogue's own predicate says),
// and its Templates table to the template catalogue's stored rows that no
// variable sets (whether the catalogue is used, as the catalogue's own
// predicate says).
//
// Usage: node scripts/check-readme-config.mjs [--src DIR] [--readme FILE] [--configuration FILE]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { settingsSource } from "./settings-source.mjs";

const PLATFORM = new Set(["NODE_ENV", "PORT", "HOSTNAME", "NEXT_RUNTIME", "TZ", "CI", "PATH", "DUCKDB_EXTENSION_DIR", "UV_THREADPOOL_SIZE"]);
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

/** Test seams the server code itself reads: process.env reads of
 * DEZFIL_TEST_* in src, test files excluded. A test file's own seam stays
 * local to it; a mention is not a read. */
export function seamVariables(srcDir) {
  const names = new Set();
  const files = walk(srcDir).filter(file => /\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.test\.(?:ts|tsx|js|mjs)$/.test(file));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [/process\.env\.(DEZFIL_TEST_[A-Z0-9_]+)/g, /process\.env\[["'](DEZFIL_TEST_[A-Z0-9_]+)["']\]/g]) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

/** Every test-wiring name read: by the helper scripts and by the server code. */
export function wiringVariables(srcDir, scriptsDir = path.join(srcDir, "..", "scripts")) {
  return new Set([...probeVariables(scriptsDir), ...seamVariables(srcDir)]);
}

/** Every operator-facing name the server code reads (src, excluding
 * tests). Three extractions, because the code reads settings three ways:
 * DEZFIL_* tokens in any context (the limits helpers take the name as
 * a string), *_API_KEY tokens in any context (the provider keys travel
 * through a name map), and direct process.env accesses for anything
 * else — minus the documented exclusions. */
export function serverVariables(srcDir, scriptsDir = path.join(srcDir, "..", "scripts")) {
  const names = wiringVariables(srcDir, scriptsDir);
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

const DEFAULTS_HEADING = /^##\s+Instance defaults\s*$/;
const RULES_HEADING = /^##\s+Security and rules\s*$/;
const LIBRARIES_HEADING = /^##\s+Libraries\s*$/;
const TEMPLATES_HEADING = /^##\s+Templates\s*$/;

/** The rows of the tables under a guide's "Instance defaults" heading, each
 * by the key its first cell names and its Default cell. Every row there
 * counts, whatever its key looks like, so an orphan cannot hide by its
 * spelling. */
export function defaultsRows(text) {
  return keyedRows(text, DEFAULTS_HEADING);
}

/** The same, under the guide's "Security and rules" heading. */
export function rulesRows(text) {
  return keyedRows(text, RULES_HEADING);
}

/** The same, under the guide's "Libraries" heading. */
export function librariesRows(text) {
  return keyedRows(text, LIBRARIES_HEADING);
}

/** The same, under the guide's "Templates" heading. */
export function templatesRows(text) {
  return keyedRows(text, TEMPLATES_HEADING);
}

function keyedRows(text, heading) {
  const normalize = value => value.replaceAll("`", "").replace(/\s+/g, " ").trim();
  const rows = [];
  let inSection = false, header = null;
  for (const line of text.split("\n")) {
    if (/^##?\s/.test(line)) { inSection = heading.test(line); header = null; continue; }
    if (!inSection || !line.startsWith("|")) { header = null; continue; }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
    if (!header) { header = cells; continue; }
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    rows.push({ name: normalize(cells[0] ?? ""), defaultValue: normalize(cells[header.indexOf("Default")] ?? "") });
  }
  return rows;
}

/** One row per default, no orphan, each with the catalogue's documented default. */
export function defaultsRowProblems(definitions, rows, label) {
  return keyedRowProblems(definitions, rows, `${label} instance defaults`);
}

/** One row per rule, no orphan, each with the catalogue's documented default. */
export function rulesRowProblems(definitions, rows, label) {
  return keyedRowProblems(definitions, rows, `${label} security and rules`);
}

/** One row per basemap switch, no orphan, each with the catalogue's documented default. */
export function librariesRowProblems(definitions, rows, label) {
  return keyedRowProblems(definitions, rows, `${label} libraries`);
}

/** One row per template catalogue setting, no orphan, each with the catalogue's documented default. */
export function templatesRowProblems(definitions, rows, label) {
  return keyedRowProblems(definitions, rows, `${label} templates`);
}

function keyedRowProblems(definitions, rows, where) {
  const byKey = new Map(definitions.map(definition => [definition.key, definition]));
  const names = new Set(rows.map(row => row.name));
  const problems = differences(new Set(byKey.keys()), names, where);
  for (const name of names) {
    const matches = rows.filter(row => row.name === name);
    if (matches.length !== 1) problems.push(`DUPLICATE: ${where}: ${name}`);
    const definition = byKey.get(name);
    if (!definition) continue;
    for (const row of matches) {
      if (row.defaultValue !== definition.documentedDefault) problems.push(
        `DEFAULT: ${where}: ${name}: expected ${JSON.stringify(definition.documentedDefault)}, found ${JSON.stringify(row.defaultValue)}`,
      );
    }
  }
  return problems;
}

/** `defaultsGuide` names the document, among `documents`, that carries the
 * Instance defaults, the Security and rules, the Libraries and the
 * Templates tables; `isInstanceDefault`, `isInstanceRule`,
 * `isLibrarySwitch` and `isTemplatesSetting` are the catalogue's own
 * predicates for which definitions each holds. */
export function configurationProblems({ srcDir, documents, catalogue, testWiring, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting }) {
  const definitions = catalogue.filter(definition => definition.environment && definition.scope !== "platform");
  const scriptsDir = path.join(srcDir, "..", "scripts");
  const server = serverVariables(srcDir, scriptsDir);
  const wiring = wiringVariables(srcDir, scriptsDir);
  const problems = differences(new Set([...definitions, ...testWiring].map(d => d.environment)), server, "source scan against catalogue");
  problems.push(...differences(new Set(testWiring.map(d => d.environment)), wiring, "test wiring reads against catalogue"));
  for (const [label, text] of Object.entries(documents)) {
    const rows = configurationRows(text).filter(row => !DOCUMENTED_PLATFORM.has(row.name));
    const deploymentRows = rows.filter(row => !row.name.startsWith("DEZFIL_TEST_"));
    const wiringRows = rows.filter(row => row.name.startsWith("DEZFIL_TEST_"));
    problems.push(...catalogueRowProblems(definitions, deploymentRows, label));
    problems.push(...catalogueRowProblems(testWiring, wiringRows, `${label} test wiring`));
    // Retain each document's direct comparison with the executable reads.
    problems.push(...differences(wiring, new Set(wiringRows.map(row => row.name)), `${label} test wiring reads`));
  }
  if (typeof isInstanceDefault !== "function") throw new TypeError("configurationProblems needs the catalogue's isInstanceDefault predicate.");
  if (typeof isInstanceRule !== "function") throw new TypeError("configurationProblems needs the catalogue's isInstanceRule predicate.");
  if (typeof isLibrarySwitch !== "function") throw new TypeError("configurationProblems needs the catalogue's isLibrarySwitch predicate.");
  if (typeof isTemplatesSetting !== "function") throw new TypeError("configurationProblems needs the catalogue's isTemplatesSetting predicate.");
  const defaults = catalogue.filter(definition => isInstanceDefault(definition));
  const rules = catalogue.filter(definition => isInstanceRule(definition));
  const switches = catalogue.filter(definition => isLibrarySwitch(definition));
  const templates = catalogue.filter(definition => isTemplatesSetting(definition));
  if (!Object.hasOwn(documents, defaultsGuide ?? "")) problems.push(`MISSING: the guide holding the Instance defaults, Security and rules, Libraries and Templates tables is not among the checked documents: ${defaultsGuide}`);
  else {
    problems.push(...defaultsRowProblems(defaults, defaultsRows(documents[defaultsGuide]), defaultsGuide));
    problems.push(...rulesRowProblems(rules, rulesRows(documents[defaultsGuide]), defaultsGuide));
    problems.push(...librariesRowProblems(switches, librariesRows(documents[defaultsGuide]), defaultsGuide));
    problems.push(...templatesRowProblems(templates, templatesRows(documents[defaultsGuide]), defaultsGuide));
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
  const { SETTING_CATALOGUE, TEST_WIRING, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting } = await settingsSource(path.dirname(srcDir));
  const problems = configurationProblems({ srcDir, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING,
    documents: { [readme]: readFileSync(readme, "utf8"), [configuration]: readFileSync(configuration, "utf8") },
    defaultsGuide: configuration, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting,
  });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} configuration discrepancies.`);
    process.exitCode = 1;
  } else {
    const deployment = SETTING_CATALOGUE.filter(d => d.environment && d.scope !== "platform").length;
    const defaults = SETTING_CATALOGUE.filter(d => isInstanceDefault(d)).length;
    const rules = SETTING_CATALOGUE.filter(d => isInstanceRule(d)).length;
    const switches = SETTING_CATALOGUE.filter(d => isLibrarySwitch(d)).length;
    const templates = SETTING_CATALOGUE.filter(d => isTemplatesSetting(d)).length;
    console.log(`PASS: both documents match ${deployment} deployment settings and ${TEST_WIRING.length} test-wiring names, defaults and change timing; the configuration guide's Instance defaults table matches the ${defaults} instance defaults, its Security and rules table the ${rules} rules, its Libraries table the ${switches} basemap switches and its Templates table the ${templates} template setting${templates === 1 ? "" : "s"}, with their documented values; source scans agree in both directions.`);
  }
}
