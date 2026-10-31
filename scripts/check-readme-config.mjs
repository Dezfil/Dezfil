// The configuration guard: the settings tables the configuration overview
// links cover the catalogue, one row each, and so does the test wiring's
// table on Development setup. The tables are generated from the catalogue
// (scripts/settings-tables.mjs) and `lint:docs` holds them to it; this
// guard reads them as they are written and holds them to the catalogue on
// its own, so a table that is current but no longer linked, a row placed by
// hand, or a generator that drifts in a default, a Settings key or a timing
// fails here too. A row's place is the generator's own areas here; the
// generator's tests pin each variable's table by its name. The README carries no
// table of its own. Keep the independent source and script scans too: a
// row in the catalogue cannot justify an unused deployment name.
//
// Two groups, each held in both directions with no duplicate row:
//   - the deployment variables, every catalogue setting a variable sets
//     (the test seams and the platform's plumbing aside), each with its
//     documented default, its Settings key where Settings changes it, and
//     how each way of changing it takes effect;
//   - the stored instance settings, every instance setting with no
//     variable, held the same way under the key the change operation takes.
// Each row sits in its area's table, on its area's page, as the catalogue's
// own predicates (what new things start with, the rules, the basemap
// switches, the template catalogue's) and the areas place it. An account's
// own preferences are outside the guard: Your settings describes them. A
// setting the overview or a page it links lists again in a table of its
// own, outside the generated ones, fails as listed twice.
//
// Coverage is defined by what `src` reads, outside the catalogue's own
// definitions and outside comments: a variable named in the code, or a
// catalogue setting resolved by its key, minus two documented exclusion
// classes:
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
// wiring in the product, and Development setup's wiring table names it,
// beside the catalogue's own test seams.
// Anything else the server reads — today that includes ANTHROPIC_API_KEY
// and OPENAI_API_KEY — must be documented.
//
// Usage: node scripts/check-readme-config.mjs [--src DIR] [--docs DIR]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { settingsSource } from "./settings-source.mjs";
import { areaOf, SETTINGS_AREAS, TEST_SEAMS, WIRING_TABLE, tableRegions } from "./settings-tables.mjs";

const PLATFORM = new Set(["NODE_ENV", "PORT", "HOSTNAME", "NEXT_RUNTIME", "TZ", "CI", "PATH", "DUCKDB_EXTENSION_DIR", "UV_THREADPOOL_SIZE"]);
const DOCUMENTED_PLATFORM = new Set([...PLATFORM, "NEXT_TELEMETRY_DISABLED"]);

/** The configuration overview, whose links name the settings tables. */
export const OVERVIEW = "docs/self-host/configuration.md";
/** The page holding the test wiring's table. */
export const WIRING_PAGE = WIRING_TABLE.page;

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

const printed = new Map();
const printer = ts.createPrinter({ removeComments: true });
/** A file's code with its comments left out, parsed rather than matched,
 * so a name a comment holds is no read and a URL or a regular expression
 * in the code stays code. Kept per file while its text is unchanged. */
export function codeOf(file) {
  const text = readFileSync(file, "utf8");
  const kept = printed.get(file);
  if (kept?.text === text) return kept.code;
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const code = printer.printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind));
  printed.set(file, { text, code });
  return code;
}

/** The catalogue's own definitions, which name every setting's variable
 * and so cannot show that anything reads one. */
const CATALOGUE_FILES = ["lib/settings/catalogue.ts", "lib/settings/numeric.ts"];
/** The calls through which the code reads a catalogue setting by its key. */
const BY_KEY = /\b(?:resolveNumber|resolveNumericSetting|resolveChoice|resolveBoolean|resolveServiceAddress|serviceAddressConfigured|settingDefinition)\(\s*["'`]([A-Za-z0-9.]+)["'`]/g;

const TEST_NAME = "DEZFIL_TEST_[A-Z0-9_]+";
/** The forms a read of a DEZFIL_TEST_* name takes: a property of the
 * environment or of any object holding it (`process.env.X`, an `env`
 * parameter's `env.X`, `process.env?.X`), the same in brackets, and a
 * name taken out by destructuring. A string that only mentions the name
 * is no read. */
const READS = [
  new RegExp(`[\\w$)\\]]\\s*\\??\\.\\s*(${TEST_NAME})\\b`, "g"),
  new RegExp(`[\\w$)\\]]\\s*(?:\\?\\.)?\\[\\s*["'\`](${TEST_NAME})["'\`]\\s*\\]`, "g"),
];
const DESTRUCTURED = /\{([^{}]*)\}\s*=(?!=|>)/g;

/** The DEZFIL_TEST_* names a file's code reads, comments left out. */
function testReads(file) {
  const names = new Set();
  const code = codeOf(file);
  for (const pattern of READS) for (const match of code.matchAll(pattern)) names.add(match[1]);
  for (const match of code.matchAll(DESTRUCTURED)) {
    for (const name of match[1].matchAll(new RegExp(`\\b(${TEST_NAME})\\b(?=\\s*[,:=}]|\\s*$)`, "g"))) names.add(name[1]);
  }
  return names;
}

/** Test-only environment reads in executable probe helpers, of any script
 * kind, not mentions. */
export function probeVariables(scriptsDir) {
  const names = new Set();
  if (!existsSync(scriptsDir)) return names;
  for (const file of walk(scriptsDir).filter(file => /\.[cm]?[jt]s$/.test(file))) for (const name of testReads(file)) names.add(name);
  return names;
}

/** Test seams the server code itself reads: reads of DEZFIL_TEST_* in
 * src, test files excluded. A test file's own seam stays local to it; a
 * mention is not a read. */
export function seamVariables(srcDir) {
  const names = new Set();
  const files = walk(srcDir).filter(file => /\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.test\.(?:ts|tsx|js|mjs)$/.test(file));
  for (const file of files) for (const name of testReads(file)) names.add(name);
  return names;
}

/** Every test-wiring name read: by the helper scripts and by the server code. */
export function wiringVariables(srcDir, scriptsDir = path.join(srcDir, "..", "scripts")) {
  return new Set([...probeVariables(scriptsDir), ...seamVariables(srcDir)]);
}

/** Every operator-facing name the server code reads (src, excluding
 * tests), comments left out. Four extractions, because the code reads
 * settings four ways: DEZFIL_* tokens in any context (a name passed as a
 * string, a message naming the variable to set), *_API_KEY tokens in any
 * context (the provider keys travel through a name map), direct
 * process.env accesses for anything else, and a catalogue setting the
 * code resolves by its key (the limits, the service addresses), which
 * counts as a read of that setting's variable — minus the documented
 * exclusions. The catalogue's own definitions are no read: a variable
 * only they name is one nothing reads. */
export function serverVariables(srcDir, scriptsDir = path.join(srcDir, "..", "scripts"), catalogue = []) {
  const names = wiringVariables(srcDir, scriptsDir);
  const files = walk(srcDir).filter(
    (f) =>
      /\.(?:ts|tsx|js|mjs)$/.test(f) && !/\.test\.(?:ts|tsx|js|mjs)$/.test(f),
  );
  const own = new Set(CATALOGUE_FILES.map(file => path.join(srcDir, file)));
  const byKey = new Map(catalogue.filter(definition => definition.environment).map(definition => [definition.key, definition.environment]));
  const patterns = [
    /\b(DEZFIL_[A-Z0-9_]+)\b/g,
    /\b([A-Z][A-Z0-9_]*_API_KEY)\b/g,
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ];
  for (const file of files) {
    if (own.has(file)) continue;
    const src = codeOf(file);
    for (const pattern of patterns) {
      for (const m of src.matchAll(pattern)) {
        // The guide names this client-side reference. A real process.env
        // read still counts through the direct-access patterns below.
        if (pattern === patterns[0] && m[1] === "DEZFIL_API_TOKEN") continue;
        if (!EXCLUDED(m[1])) names.add(m[1]);
      }
    }
    for (const m of src.matchAll(BY_KEY)) if (byKey.has(m[1]) && !EXCLUDED(byKey.get(m[1]))) names.add(byKey.get(m[1]));
  }
  return names;
}

const normalize = (value) => value.replace(/\s+/g, " ").trim();
/** A cell's first code span, or the cell as words when it holds none. */
const valueOf = (value) => {
  const span = /(`+)(.+?)\1/.exec(value ?? "");
  return span ? span[2].trim() : normalize((value ?? "").replaceAll("`", ""));
};
/** A cell's first code span, or nothing. */
const nameOf = (value) => /(`+)(.+?)\1/.exec(value ?? "")?.[2].trim() ?? "";

/** The rows of a page's settings tables and test wiring table, as written:
 * each with its table, its line (1-based), the variable and the Settings
 * key it names, its Default cell (the first code span, or the words) and
 * its Changes cell. Cells are read by the table's header, so a lost column
 * reads as an empty cell, never as its neighbour. */
export function settingsRows(text, page = "") {
  const rows = [];
  for (const region of tableRegions(text)) {
    if (region.end === null) continue;
    let header = null;
    region.content.split("\n").forEach((line, i) => {
      if (!line.startsWith("|")) { header = null; return; }
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
      if (!header) { header = cells; return; }
      if (cells.every(cell => /^:?-+:?$/.test(cell))) return;
      const at = (name) => cells[header.indexOf(name)];
      rows.push({
        page, table: region.name, line: region.start + 1 + i,
        variable: nameOf(at("Variable")), key: nameOf(at("Settings key")),
        defaultValue: valueOf(at("Default")), changes: normalize(at("Changes") ?? ""),
      });
    });
  }
  return rows;
}

/** The settings a page lists by hand: each of these names written in a
 * code span on a table row outside the generated tables and outside code
 * blocks, with its line (1-based). A table of its own beside a generated
 * one is a second home for the setting, with defaults nothing holds. */
export function handListedNames(text, names) {
  const lines = text.split("\n");
  const generated = new Set();
  for (const region of tableRegions(text)) for (let line = region.start; line <= (region.end ?? lines.length); line++) generated.add(line);
  const found = [];
  let fence = null;
  lines.forEach((line, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null; return; }
    if (marker) { fence = marker[1]; return; }
    if (generated.has(i + 1) || !line.trimStart().startsWith("|")) return;
    for (const span of line.matchAll(/(`+)(.+?)\1/g)) if (names.has(span[2].trim())) found.push({ line: i + 1, name: span[2].trim() });
  });
  return found;
}

/** The pages the overview links, in the order it first links them, as
 * paths under docs/; links to other sites and to the overview itself are
 * left out, and so are links inside code and inside HTML comments, which
 * no reader follows. */
export function linkedPages(documents, overview = OVERVIEW) {
  const text = (documents[overview] ?? "").replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const pages = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    const page = path.posix.normalize(path.posix.join(path.posix.dirname(overview), decodeURI(target)));
    if (page !== overview && Object.hasOwn(documents, page) && !pages.includes(page)) pages.push(page);
  }
  return pages;
}

/** Every variable the settings tables and the test wiring table of these
 * pages document, platform plumbing (listed by name and outside the check)
 * left out. */
export function documentedVariables(...files) {
  const names = new Set();
  for (const file of files) {
    for (const row of settingsRows(readFileSync(file, "utf8"), file)) {
      if (row.variable && !DOCUMENTED_PLATFORM.has(row.variable)) names.add(row.variable);
    }
  }
  return names;
}

export function judge(server, documented) {
  const undocumented = [...server].filter((n) => !documented.has(n)).sort();
  const stale = [...documented].filter((n) => !server.has(n)).sort();
  return { undocumented, stale };
}

function differences(expected, actual, label) {
  const { undocumented, stale } = judge(expected, actual);
  return [
    ...undocumented.map(name => `UNDOCUMENTED: ${label}: ${name}`),
    ...stale.map(name => `STALE: ${label}: ${name}`),
  ];
}

/** How each way of changing a setting takes effect, in the tables' words:
 * a change in Settings live or after a restart, as the catalogue times it,
 * and a variable after a restart, as every variable is. */
function changesFor(definition) {
  const ways = [];
  if (definition.editable) ways.push(`in Settings, ${definition.timing === "live" ? "live" : "after a restart"}`);
  if (definition.environment) ways.push(`by variable, ${definition.environmentTiming === "restart" ? "after a restart" : "live"}`);
  const text = ways.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const shown = (value) => (value ? JSON.stringify(value) : "no Settings key");

/** One group's coverage: every name once, across the tables. */
function coverage(names, found, group) {
  const problems = [];
  for (const name of names) {
    const where = found.get(name) ?? [];
    if (where.length === 0) problems.push(`UNDOCUMENTED: ${group}: ${name}`);
    if (where.length > 1) problems.push(`DUPLICATE: ${group}: ${name} (${where.join(", ")})`);
  }
  return problems;
}

/** `documents` maps each page under docs/ to its text, keyed `docs/...`;
 * the settings tables are those of the pages `overview` links.
 * `isInstanceDefault`, `isInstanceRule`, `isLibrarySwitch` and
 * `isTemplatesSetting` are the catalogue's own predicates, which place a
 * stored setting's row in its table. */
export function configurationProblems({ srcDir, scriptsDir = path.join(srcDir, "..", "scripts"), documents, catalogue, testWiring, overview = OVERVIEW,
  isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting }) {
  const predicates = { isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting };
  for (const [name, predicate] of Object.entries(predicates)) {
    if (typeof predicate !== "function") throw new TypeError(`configurationProblems needs the catalogue's ${name} predicate.`);
  }
  const variables = catalogue.filter(definition => definition.environment && definition.scope !== "platform");
  const seams = variables.filter(definition => TEST_SEAMS.includes(definition.key));
  const deployment = variables.filter(definition => !TEST_SEAMS.includes(definition.key));
  const stored = catalogue.filter(definition => definition.scope === "instance" && !definition.environment);

  const server = serverVariables(srcDir, scriptsDir, catalogue);
  const wiring = wiringVariables(srcDir, scriptsDir);
  const problems = differences(new Set([...variables, ...testWiring].map(d => d.environment)), server, "source scan against catalogue");
  problems.push(...differences(new Set(testWiring.map(d => d.environment)), wiring, "test wiring reads against catalogue"));

  // The settings tables the overview links, row by row.
  if (!Object.hasOwn(documents, overview)) problems.push(`MISSING: the configuration overview is not among the checked documents: ${overview}`);
  const byVariable = new Map(variables.map(definition => [definition.environment, definition]));
  const byKey = new Map(stored.map(definition => [definition.key, definition]));
  const homes = new Map(SETTINGS_AREAS.map(area => [area.id, area]));
  const found = new Map();
  const linked = linkedPages(documents, overview);
  for (const page of linked) {
    for (const row of settingsRows(documents[page], page)) {
      if (!row.table.startsWith("settings-") || DOCUMENTED_PLATFORM.has(row.variable)) continue;
      const where = `${page} ${row.table}`;
      const name = row.variable || row.key;
      if (!name) { problems.push(`UNNAMED: ${where}: line ${row.line} names neither a variable nor a Settings key`); continue; }
      const definition = row.variable ? byVariable.get(row.variable) : byKey.get(row.key);
      if (!definition) { problems.push(`STALE: ${where}: ${name}`); continue; }
      if (TEST_SEAMS.includes(definition.key)) {
        problems.push(`MISPLACED: ${where}: ${name}: a test seam, documented with the test wiring on ${WIRING_PAGE}`);
        continue;
      }
      found.set(name, [...(found.get(name) ?? []), where]);
      const home = homes.get(areaOf(definition, predicates));
      if (!home) problems.push(`MISPLACED: ${where}: ${name}: no settings table takes it`);
      else if (home.table !== row.table || home.page !== page) problems.push(`MISPLACED: ${where}: ${name}: belongs in the ${home.table} table on ${home.page}`);
      if (row.defaultValue !== definition.documentedDefault) problems.push(
        `DEFAULT: ${where}: ${name}: expected ${JSON.stringify(definition.documentedDefault)}, found ${JSON.stringify(row.defaultValue)}`,
      );
      const key = definition.editable ? definition.key : "";
      if (row.key !== key) problems.push(`KEY: ${where}: ${name}: expected ${shown(key)}, found ${shown(row.key)}`);
      const changes = changesFor(definition);
      if (row.changes !== changes) problems.push(
        `CHANGES: ${where}: ${name}: expected ${JSON.stringify(changes)}, found ${JSON.stringify(row.changes)}`,
      );
    }
  }
  // A setting a page beside the tables lists by hand, the overview included.
  // Contribute's recipes name settings to start an instance for the tests,
  // which lists no setting a second time.
  const listable = new Set([...variables.flatMap(definition => definition.editable ? [definition.environment, definition.key] : [definition.environment]),
    ...stored.map(definition => definition.key), ...testWiring.map(entry => entry.environment)]);
  for (const page of [overview, ...linked].filter(page => !page.startsWith("docs/contribute/"))) {
    for (const { line, name } of handListedNames(documents[page] ?? "", listable)) {
      problems.push(`DUPLICATE: ${page}: line ${line}: ${name} is listed outside its settings table; link the table instead`);
    }
  }
  problems.push(...coverage(deployment.map(definition => definition.environment), found, "deployment variables"));
  problems.push(...coverage(stored.map(definition => definition.key), found, "stored instance settings"));

  // The test wiring's table: the catalogue's test wiring and test seams,
  // and every DEZFIL_TEST_* the code reads.
  const label = `${WIRING_PAGE} test wiring`;
  const wiringRows = settingsRows(documents[WIRING_PAGE] ?? "", WIRING_PAGE).filter(row => row.table === WIRING_TABLE.table);
  const entries = new Map([...testWiring, ...seams].map(entry => [entry.environment, entry]));
  problems.push(...differences(new Set(entries.keys()), new Set(wiringRows.map(row => row.variable)), label));
  for (const name of new Set(wiringRows.map(row => row.variable))) {
    const matches = wiringRows.filter(row => row.variable === name);
    if (matches.length > 1) problems.push(`DUPLICATE: ${label}: ${name}`);
    const entry = entries.get(name);
    if (!entry) continue;
    for (const row of matches) {
      if (row.defaultValue !== entry.documentedDefault) problems.push(
        `DEFAULT: ${label}: ${name}: expected ${JSON.stringify(entry.documentedDefault)}, found ${JSON.stringify(row.defaultValue)}`,
      );
    }
  }
  // Retain the table's direct comparison with the executable reads.
  problems.push(...differences(wiring, new Set(wiringRows.map(row => row.variable).filter(name => name.startsWith("DEZFIL_TEST_"))), `${label} reads`));
  return problems;
}

/** Every page under a docs folder, keyed `docs/...`. */
export function readDocuments(docsDir) {
  return Object.fromEntries(walk(docsDir).filter(file => file.endsWith(".md"))
    .map(file => [`docs/${path.relative(docsDir, file).split(path.sep).join("/")}`, readFileSync(file, "utf8")]));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const srcDir = argOf("--src", path.join(process.cwd(), "src"));
  const docsDir = argOf("--docs", path.join(process.cwd(), "docs"));
  const { SETTING_CATALOGUE, TEST_WIRING, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting } = await settingsSource(path.dirname(srcDir));
  const problems = configurationProblems({ srcDir, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, documents: readDocuments(docsDir),
    isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} configuration discrepancies.`);
    process.exitCode = 1;
  } else {
    const variables = SETTING_CATALOGUE.filter(d => d.environment && d.scope !== "platform");
    const seams = variables.filter(d => TEST_SEAMS.includes(d.key)).length;
    const stored = SETTING_CATALOGUE.filter(d => d.scope === "instance" && !d.environment).length;
    console.log(`PASS: the settings tables the configuration overview links list the ${variables.length - seams} deployment variables and the ${stored} stored instance settings once each, in their areas' tables, with their documented defaults, Settings keys and change timing; Development setup lists the ${TEST_WIRING.length} test-wiring names and ${seams} test seam${seams === 1 ? "" : "s"}; source scans agree in both directions.`);
  }
}
