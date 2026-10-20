import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { isLibrarySwitch, isTemplatesSetting, SETTING_CATALOGUE, TEST_WIRING } from "./settings/catalogue";
import { isInstanceDefault } from "./settings/instance-defaults";
import { isInstanceRule } from "./settings/instance-security";
import { configurationProblems, settingsRows } from "../../scripts/check-readme-config.mjs";
import { addressRows, serviceNumberRows } from "@/components/settings/data-table";

// The configuration guard reads the settings tables the configuration
// overview links, as they are written, and holds them to the catalogue on
// its own: every deployment variable and every stored instance setting has
// exactly one row, in its area's table, with its documented default, its
// Settings key and its change timing; the test wiring and the test seams
// the code reads are on Development setup. Every rule is shown red.

const root = process.cwd();
const scratch = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "configuration-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OVERVIEW = "docs/self-host/configuration.md";
const WIRING = "docs/contribute/development-setup.md";
const LIMITS = "docs/api/limits.md";
const LIVE = "In Settings, live; by variable, after a restart";
const RESTART = "By variable, after a restart";
type Documents = Record<string, string>;
/** Every page under docs/, as the check reads them. */
const originals: Documents = Object.fromEntries(readdirSync("docs", { recursive: true, encoding: "utf8" })
  .filter(file => file.endsWith(".md")).map(file => [`docs/${file.split(path.sep).join("/")}`, readFileSync(path.join("docs", file), "utf8")]));
const predicates = { isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting };
const srcDir = path.join(root, "src");
const variable = "DEZFIL_UPLOAD_MAX_MB";

/** The guard's problems over these documents and this catalogue. */
const problemsOf = (documents: Documents = originals, over: Record<string, unknown> = {}): string[] =>
  configurationProblems({ srcDir, documents, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, ...predicates, ...over });

/** The page whose settings table lists a variable or Settings key, and the row. */
function rowOf(documents: Documents, name: string): { page: string; row: string } {
  for (const [page, text] of Object.entries(documents)) {
    const found = (settingsRows(text, page) as { variable: string; key: string; line: number }[]).find(row => row.variable === name || (!row.variable && row.key === name));
    if (found) return { page, row: text.split("\n")[found.line - 1] };
  }
  throw new Error(`no settings table lists ${name}`);
}
/** The documents with one row changed; the seed must change something. */
function changeRow(documents: Documents, name: string, change: (row: string) => string): Documents {
  const { page, row } = rowOf(documents, name);
  const text = documents[page];
  const next = text.replace(`${row}\n`, change(row) === "" ? "" : `${change(row)}\n`);
  expect(next, `the seed must alter ${page}`).not.toBe(text);
  return { ...documents, [page]: next };
}
/** A row with one cell replaced, counted from 0. */
function cell(row: string, position: number, value: string) {
  const cells = row.split(/(?<!\\)\|/); cells[position + 1] = ` ${value} `; return cells.join("|");
}
const COLUMN = { setting: 0, variable: 1, key: 2, default: 3, values: 4, does: 5, changes: 6 };
/** The documents with the overview's link to a page taken out. */
function unlinked(documents: Documents, page: string): Documents {
  const target = path.posix.relative(path.posix.dirname(OVERVIEW), page);
  const text = documents[OVERVIEW];
  const next = text.replace(new RegExp(`\\]\\(${target.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(#[^)]*)?\\)`, "g"), "](#settings-tables)");
  expect(next, `the overview links ${target}`).not.toBe(text);
  return { ...documents, [OVERVIEW]: next };
}

/** The guard as `npm run lint:readme` runs it, over a copy of the pages. */
function check(documents: Documents = originals) {
  const run = mkdtempSync(path.join(scratch, "run-"));
  for (const [file, text] of Object.entries(documents)) {
    mkdirSync(path.join(run, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(run, file), text);
  }
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-readme-config.mjs"), "--docs", path.join(run, "docs")], {
    encoding: "utf8", env: { ...process.env, DEZFIL_DATA_DIR: run },
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}
const reported = (output: string) => output.split("\n").filter(line => /^[A-Z ]+: /.test(line) && !line.startsWith("FAIL") && !line.startsWith("PASS"));

it("checks the real tables against the catalogue and keeps the script wiring check", () => {
  const result = check();
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("67 deployment variables");
  expect(result.output).toContain("40 stored instance settings");
  expect(result.output).toContain("4 test-wiring names");
  expect(result.output).toContain("1 test seam");
  expect(problemsOf()).toEqual([]);
});

it("holds the settings tables alone: the README and the overview carry no table of their own, and a row removed from a table fails", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  expect(readme.split("\n").filter(line => /^\|\s*`[A-Z][A-Z0-9_]+`/.test(line))).toEqual([]);
  expect(settingsRows(originals[OVERVIEW], OVERVIEW)).toEqual([]);
  const names = new Set([...SETTING_CATALOGUE.filter(definition => definition.scope === "instance").flatMap(definition => [definition.environment, definition.key]),
    ...TEST_WIRING.map(wiring => wiring.environment)].filter(Boolean));
  const handRows = originals[OVERVIEW].split("\n").filter(line => line.startsWith("|")
    && line.split(/(?<!\\)\|/).slice(1, 3).some(cell => names.has(cell.trim().replace(/^`|`$/g, ""))));
  expect(handRows).toEqual([]);
  const removed = check(changeRow(originals, "DEZFIL_QUERY_TIMEOUT_S", () => ""));
  expect(removed.status, removed.output).toBe(1);
  expect(reported(removed.output)).toEqual(["UNDOCUMENTED: deployment variables: DEZFIL_QUERY_TIMEOUT_S"]);
});

it("takes defaults, editability and timing from the supplied catalogue, not a copy in the checker", () => {
  const catalogue = SETTING_CATALOGUE.map(definition => definition.key === "uploadMaxMb"
    ? { ...definition, documentedDefault: "777", editable: false, timing: "next-start" as const } : definition);
  expect([...problemsOf(originals, { catalogue })].sort()).toEqual([
    `CHANGES: ${LIMITS} settings-limits: ${variable}: expected "${RESTART}", found "${LIVE}"`,
    `DEFAULT: ${LIMITS} settings-limits: ${variable}: expected "777", found "5120"`,
    `KEY: ${LIMITS} settings-limits: ${variable}: expected no Settings key, found "uploadMaxMb"`,
  ]);
});

it("rejects deployment and test-wiring names removed from the catalogue while reads remain", () => {
  const problems = problemsOf(originals, { catalogue: SETTING_CATALOGUE.filter(definition => definition.environment !== variable), testWiring: TEST_WIRING.slice(1) });
  for (const name of [variable, TEST_WIRING[0].environment]) expect(problems).toContain(`STALE: source scan against catalogue: ${name}`);
  expect(problems).toContain(`STALE: ${LIMITS} settings-limits: ${variable}`);
  expect(problems).toContain(`STALE: ${WIRING} test wiring: ${TEST_WIRING[0].environment}`);
});

describe("catalogue drift", () => {
  const seeds: [string, (documents: Documents) => Documents, string[]][] = [
    ["missing deployment row", d => changeRow(d, variable, () => ""), [`UNDOCUMENTED: deployment variables: ${variable}`]],
    ["orphan deployment row", d => changeRow(d, variable, row => `${row}\n| **Orphan** | \`DEZFIL_ORPHAN_SETTING\` |  | \`1\` | Any | Orphan. | ${RESTART} |`),
      [`STALE: ${LIMITS} settings-limits: DEZFIL_ORPHAN_SETTING`]],
    ["wrong default", d => changeRow(d, variable, row => cell(row, COLUMN.default, "`999` MB")),
      [`DEFAULT: ${LIMITS} settings-limits: ${variable}: expected "5120", found "999"`]],
    ["missing editable mark", d => changeRow(d, variable, row => cell(row, COLUMN.changes, RESTART)),
      [`CHANGES: ${LIMITS} settings-limits: ${variable}: expected "${LIVE}", found "${RESTART}"`]],
    ["false editable mark", d => changeRow(d, "DEZFIL_QUERY_MEMORY_MB", row => cell(row, COLUMN.changes, LIVE)),
      [`CHANGES: ${LIMITS} settings-limits: DEZFIL_QUERY_MEMORY_MB: expected "${RESTART}", found "${LIVE}"`]],
    ["wrong timing", d => changeRow(d, variable, row => cell(row, COLUMN.changes, "In Settings, after a restart; by variable, after a restart")),
      [`CHANGES: ${LIMITS} settings-limits: ${variable}: expected "${LIVE}", found "In Settings, after a restart; by variable, after a restart"`]],
    ["wrong Settings key", d => changeRow(d, variable, row => cell(row, COLUMN.key, "`remoteMaxMb`")),
      [`KEY: ${LIMITS} settings-limits: ${variable}: expected "uploadMaxMb", found "remoteMaxMb"`]],
    ["duplicate row", d => changeRow(d, variable, row => `${row}\n${row}`),
      [`DUPLICATE: deployment variables: ${variable} (${LIMITS} settings-limits, ${LIMITS} settings-limits)`]],
    ["row listed twice, in two tables", d => changeRow(d, "DEZFIL_DATA_DIR", row => `${row}\n${rowOf(d, variable).row}`), [
      `DUPLICATE: deployment variables: ${variable} (docs/self-host/configuration/storage.md settings-storage, ${LIMITS} settings-limits)`,
      `MISPLACED: docs/self-host/configuration/storage.md settings-storage: ${variable}: belongs in the settings-limits table on ${LIMITS}`,
    ]],
    ["row moved to another area's table", d => changeRow(changeRow(d, variable, () => ""), "DEZFIL_DATA_DIR", row => `${row}\n${rowOf(d, variable).row}`),
      [`MISPLACED: docs/self-host/configuration/storage.md settings-storage: ${variable}: belongs in the settings-limits table on ${LIMITS}`]],
    ["table the overview does not link", d => unlinked(d, "docs/self-host/reverse-proxy.md"),
      ["UNDOCUMENTED: deployment variables: DEZFIL_TRUSTED_PROXIES", "UNDOCUMENTED: deployment variables: DEZFIL_SESSION_COOKIE"]],
  ];
  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problems) => {
    expect([...problemsOf(seed(originals))].sort()).toEqual([...problems].sort());
  });
  it.each(seeds.slice(0, 8))("fails the command on seeded %s", (_label, seed, problems) => {
    const result = check(seed(originals));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).sort()).toEqual([...problems].sort());
  });
  it("rejects a table whose change column is lost, a row at a time", () => {
    const text = originals[LIMITS];
    const lost = text.replace("| What it does | Changes |", "| What it does | How changed |");
    expect(lost).not.toBe(text);
    const problems = problemsOf({ ...originals, [LIMITS]: lost });
    expect(problems.filter(problem => problem.startsWith(`CHANGES: ${LIMITS} settings-limits: `))).toHaveLength(rowsIn(LIMITS));
    expect(problems.every(problem => problem.startsWith("CHANGES: "))).toBe(true);
  });
  it.each(TEST_WIRING)("rejects removal of test wiring $environment", ({ environment }) => {
    const problems = problemsOf(changeRow(originals, environment, () => ""));
    expect(problems).toContain(`UNDOCUMENTED: ${WIRING} test wiring: ${environment}`);
    expect(problems).toContain(`UNDOCUMENTED: ${WIRING} test wiring reads: ${environment}`);
  });
  it("rejects an orphan test-wiring row", () => {
    const seeded = changeRow(originals, TEST_WIRING[0].environment, row => `${row}\n| \`DEZFIL_TEST_ORPHAN\` | unset | Orphan. |`);
    expect([...problemsOf(seeded)].sort()).toEqual([`STALE: ${WIRING} test wiring reads: DEZFIL_TEST_ORPHAN`, `STALE: ${WIRING} test wiring: DEZFIL_TEST_ORPHAN`]);
  });
});

describe("a setting listed by hand", () => {
  const SERVICES = "docs/self-host/configuration/services.md";
  const RULES = "docs/self-host/configuration/rules.md";
  /** The documents with a hand-written table after a page's generated one, and the line its row lands on. */
  function handTable(documents: Documents, page: string, rows: string[]): { documents: Documents; line: number } {
    const text = documents[page];
    const end = /<!-- [a-z-]+:end -->\n/.exec(text)!;
    const table = ["", "| Setting | Default |", "|---|---|", ...rows].join("\n");
    const next = `${text.slice(0, end.index + end[0].length)}${table}\n${text.slice(end.index + end[0].length)}`;
    return { documents: { ...documents, [page]: next }, line: text.slice(0, end.index + end[0].length).split("\n").length + 3 };
  }

  it("fails a variable or a Settings key repeated in a table of its own beside the generated one, with a default of its own", () => {
    const pace = handTable(originals, SERVICES, ["| `DEZFIL_GEOCODE_PACE_MS` | `250` milliseconds |"]);
    expect(problemsOf(pace.documents)).toEqual([
      `DUPLICATE: ${SERVICES}: line ${pace.line}: DEZFIL_GEOCODE_PACE_MS is listed outside its settings table; link the table instead`,
    ]);
    const password = handTable(originals, RULES, ["| `security.passwordMin` | `12` characters |"]);
    expect(problemsOf(password.documents)).toEqual([
      `DUPLICATE: ${RULES}: line ${password.line}: security.passwordMin is listed outside its settings table; link the table instead`,
    ]);
    const result = check(pace.documents);
    expect(result.status, result.output).toBe(1);
  });

  it("leaves a Contribute page's recipe alone, which names a setting to start an instance for the tests", () => {
    const recipe = handTable(originals, WIRING, ["| `DEZFIL_RENDER_CAP_FEATURES=2000` | The layers cross the cap |", "| `DEZFIL_DATA_DIR` | A fresh folder |"]);
    const linking = `${originals[OVERVIEW]}\nSee [Development setup](../contribute/development-setup.md).\n`;
    expect(problemsOf({ ...recipe.documents, [OVERVIEW]: linking })).toEqual([]);
  });

  it("fails one on the overview itself, and leaves a name shown in a code block alone", () => {
    const text = originals[OVERVIEW];
    const listed = `${text}\n| Variable | Default |\n|---|---|\n| \`${variable}\` | \`4096\` MB |\n`;
    expect(problemsOf({ ...originals, [OVERVIEW]: listed })).toEqual([
      `DUPLICATE: ${OVERVIEW}: line ${text.split("\n").length + 3}: ${variable} is listed outside its settings table; link the table instead`,
    ]);
    const shown = `${text}\n\`\`\`text title="Example"\n| \`${variable}\` | \`4096\` MB |\n\`\`\`\n`;
    expect(problemsOf({ ...originals, [OVERVIEW]: shown })).toEqual([]);
  });
});

/** How many rows a page's settings tables hold. */
const rowsIn = (page: string) => settingsRows(originals[page], page).length;

describe("the test seams the product code reads", () => {
  const seam = "DEZFIL_TEST_EXTENSION_REPOSITORY";

  it("hold the engine's extension repository as test wiring, unset by default, on Development setup", () => {
    expect(TEST_WIRING.map(wiring => wiring.environment)).toContain(seam);
    const rows = (settingsRows(originals[WIRING], WIRING) as { variable: string; defaultValue: string }[]).filter(row => row.variable === seam);
    expect(rows.map(row => ({ variable: row.variable, defaultValue: row.defaultValue }))).toEqual([{ variable: seam, defaultValue: "unset" }]);
    expect(problemsOf()).toEqual([]);
  });

  it("rejects the seam taken from the catalogue while the engine still reads it", () => {
    const problems = problemsOf(originals, { testWiring: TEST_WIRING.filter(wiring => wiring.environment !== seam) });
    expect(problems).toContain(`STALE: source scan against catalogue: ${seam}`);
    expect(problems).toContain(`STALE: test wiring reads against catalogue: ${seam}`);
    expect(problems).toContain(`STALE: ${WIRING} test wiring: ${seam}`);
  });

  it("rejects a seam the product code reads that the catalogue and Development setup do not name, and leaves one a test file reads to that file", () => {
    const src = mkdtempSync(path.join(scratch, "src-"));
    writeFileSync(path.join(src, "engine.ts"), "export const repository = process.env.DEZFIL_TEST_NEW_SEAM;\n");
    writeFileSync(path.join(src, "engine.test.ts"), "export const local = process.env.DEZFIL_TEST_FILE_LOCAL;\n");
    const problems = configurationProblems({ srcDir: src, scriptsDir: path.join(root, "scripts"), documents: originals, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, ...predicates });
    expect(problems.filter((problem: string) => problem.includes("DEZFIL_TEST_NEW_SEAM")).sort()).toEqual([
      "STALE: source scan against catalogue: DEZFIL_TEST_NEW_SEAM",
      "STALE: test wiring reads against catalogue: DEZFIL_TEST_NEW_SEAM",
      `UNDOCUMENTED: ${WIRING} test wiring reads: DEZFIL_TEST_NEW_SEAM`,
    ]);
    expect(problems.filter((problem: string) => problem.includes("DEZFIL_TEST_FILE_LOCAL"))).toEqual([]);
  });

  it("keep the catalogue's Overture endpoint with the test wiring on Development setup, and in no operator table", () => {
    const name = "DEZFIL_OVERTURE_S3_ENDPOINT";
    expect(rowOf(originals, name).page).toBe(WIRING);
    expect(problemsOf(changeRow(originals, name, () => ""))).toEqual([`UNDOCUMENTED: ${WIRING} test wiring: ${name}`]);
    const moved = changeRow(originals, "DEZFIL_DATA_DIR", row => `${row}\n| **Overture endpoint** | \`${name}\` |  | unset, the public bucket | An address | Override. | ${RESTART} |`);
    expect(problemsOf(moved)).toEqual([`MISPLACED: docs/self-host/configuration/storage.md settings-storage: ${name}: a test seam, documented with the test wiring on ${WIRING}`]);
  });
});

/** The keyed groups the catalogue's own predicates name, each in its own table. */
describe.each([
  { group: "instance defaults", table: "settings-defaults", page: "docs/self-host/configuration/defaults.md", predicate: isInstanceDefault, key: "newLayer.lineOpacity", value: "95", orphan: "newLayer.haloWidth", count: 18 },
  { group: "security and rules", table: "settings-rules", page: "docs/self-host/configuration/rules.md", predicate: isInstanceRule, key: "security.passwordMin", value: "8", orphan: "security.twoFactor", count: 12 },
  { group: "basemap switches", table: "settings-libraries", page: "docs/self-host/configuration/libraries.md", predicate: isLibrarySwitch, key: "basemaps.streets", value: "on", orphan: "basemaps.terrain", count: 5 },
  { group: "template catalogue", table: "settings-services", page: "docs/self-host/configuration/services.md", predicate: isTemplatesSetting, key: "templates.catalogue", value: "on", orphan: "templates.autoFetch", count: 1 },
])("the $group, in the $table table", ({ table, page, predicate, key, value, orphan, count }) => {
  const where = `${page} ${table}`;
  const seeds: [string, (documents: Documents) => Documents, string[]][] = [
    ["missing row", d => changeRow(d, key, () => ""), [`UNDOCUMENTED: stored instance settings: ${key}`]],
    ["orphan row", d => changeRow(d, key, row => `${row}\n| **Orphan** |  | \`${orphan}\` | \`${value}\` | Any | Orphan. | In Settings, live |`), [`STALE: ${where}: ${orphan}`]],
    ["wrong default", d => changeRow(d, key, row => cell(row, COLUMN.default, "`90`")), [`DEFAULT: ${where}: ${key}: expected "${value}", found "90"`]],
    ["duplicate row", d => changeRow(d, key, row => `${row}\n${row}`), [`DUPLICATE: stored instance settings: ${key} (${where}, ${where})`]],
    ["timing", d => changeRow(d, key, row => cell(row, COLUMN.changes, "In Settings, after a restart")), [`CHANGES: ${where}: ${key}: expected "In Settings, live", found "In Settings, after a restart"`]],
  ];
  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problems) => {
    expect(problemsOf(seed(originals))).toEqual(problems);
  });

  it("holds every row of the group, and the table, to the catalogue's predicate", () => {
    const keys = SETTING_CATALOGUE.filter(definition => predicate(definition)).map(definition => definition.key);
    expect(keys).toHaveLength(count);
    const rows = (settingsRows(originals[page], page) as { table: string; key: string }[]).filter(row => row.table === table).map(row => row.key);
    for (const name of keys) expect(rows, name).toContain(name);
  });

  it("rejects the table the overview no longer links, naming every row of it", () => {
    const problems = problemsOf(unlinked(originals, page));
    expect(problems).toHaveLength(rowsIn(page));
    expect(problems.every(problem => problem.startsWith("UNDOCUMENTED: "))).toBe(true);
    for (const name of SETTING_CATALOGUE.filter(definition => predicate(definition)).map(definition => definition.key)) {
      expect(problems).toContain(`UNDOCUMENTED: stored instance settings: ${name}`);
    }
  });

  it("rejects the table whose default column is lost, a default at a time", () => {
    const text = originals[page];
    const lost = text.replace("| Settings key | Default | Values |", "| Settings key | Starts as | Values |");
    expect(lost).not.toBe(text);
    const problems = problemsOf({ ...originals, [page]: lost });
    expect(problems).toHaveLength(rowsIn(page));
    expect(problems.every(problem => problem.startsWith(`DEFAULT: ${where}: `))).toBe(true);
  });

  it("holds the table to the supplied catalogue, not a copy in the checker", () => {
    const keys = SETTING_CATALOGUE.filter(definition => predicate(definition)).map(definition => definition.key);
    const first = SETTING_CATALOGUE.find(definition => definition.key === keys[0])!;
    const last = keys.at(-1)!;
    const catalogue = [
      ...SETTING_CATALOGUE.filter(definition => keys.length === 1 || definition.key !== last)
        .map(definition => definition.key === key ? { ...definition, documentedDefault: "changed" } : definition),
      { ...first, key: orphan },
    ];
    const expected = [`DEFAULT: ${where}: ${key}: expected "changed", found "${value}"`, `UNDOCUMENTED: stored instance settings: ${orphan}`];
    if (keys.length > 1) expected.push(`STALE: ${where}: ${last}`);
    expect([...problemsOf(originals, { catalogue })].sort()).toEqual(expected.sort());
  });
});

describe("a row moved into another group's table", () => {
  it.each([
    ["imports.links", "settings-defaults", "docs/self-host/configuration/defaults.md", "imageExport.shape", "settings-rules", "docs/self-host/configuration/rules.md"],
    ["basemaps.singleMapStyles", "settings-rules", "docs/self-host/configuration/rules.md", "imports.links", "settings-libraries", "docs/self-host/configuration/libraries.md"],
    ["templates.catalogue", "settings-libraries", "docs/self-host/configuration/libraries.md", "basemaps.streets", "settings-services", "docs/self-host/configuration/services.md"],
  ])("rejects %s under %s, naming only it", (key, table, page, beside, home, homePage) => {
    const moved = changeRow(changeRow(originals, key, () => ""), beside, row => `${row}\n${rowOf(originals, key).row}`);
    expect(problemsOf(moved)).toEqual([`MISPLACED: ${page} ${table}: ${key}: belongs in the ${home} table on ${homePage}`]);
  });

  it("counts the stored sign-in, token, publishing, connection and import settings, and nothing else, as rules", () => {
    expect(SETTING_CATALOGUE.filter(definition => isInstanceRule(definition)).map(definition => definition.key)).toEqual([
      "security.sessionDays", "security.linkDays", "security.failedPerAccount", "security.failedPerAddress", "security.passwordMin",
      "tokens.create", "tokens.expiry", "publishing.publish", "publishing.embedding", "publishing.embedSites",
      "connections.create", "imports.links",
    ]);
    expect(SETTING_CATALOGUE.filter(definition => isInstanceRule(definition) && isInstanceDefault(definition))).toEqual([]);
  });

  it("counts the five basemap switches and the one template setting, and nothing else, as their groups", () => {
    expect(SETTING_CATALOGUE.filter(definition => isLibrarySwitch(definition)).map(definition => definition.key)).toEqual([
      "basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles",
    ]);
    expect(SETTING_CATALOGUE.filter(definition => isTemplatesSetting(definition)).map(definition => definition.key)).toEqual(["templates.catalogue"]);
    expect(SETTING_CATALOGUE.filter(definition => (isLibrarySwitch(definition) || isTemplatesSetting(definition))
      && (isInstanceDefault(definition) || isInstanceRule(definition)))).toEqual([]);
  });

  it.each(["isInstanceDefault", "isInstanceRule", "isLibrarySwitch", "isTemplatesSetting"])("refuses a check without the catalogue's %s predicate", name => {
    expect(() => problemsOf(originals, { [name]: undefined })).toThrow(name);
  });
});

describe("the template catalogue's address, stored on Data & services", () => {
  const name = "DEZFIL_TEMPLATES_CATALOGUE";
  const where = "docs/self-host/configuration/services.md settings-services";
  const DEFAULT = "https://github.com/Dezfil/templates/releases/latest/download/index.json";

  it("is marked as changed in Settings or by its variable, with the release catalogue as its default", () => {
    const rows = (settingsRows(originals[rowOf(originals, name).page], "") as { variable: string; defaultValue: string; changes: string }[]).filter(row => row.variable === name);
    expect(rows.map(row => ({ defaultValue: row.defaultValue, changes: row.changes }))).toEqual([{ defaultValue: DEFAULT, changes: LIVE }]);
  });

  it("rejects it marked as changed only by a restart, lost, or with another default, naming it alone", () => {
    expect(problemsOf(changeRow(originals, name, row => cell(row, COLUMN.changes, RESTART)))).toEqual([`CHANGES: ${where}: ${name}: expected "${LIVE}", found "${RESTART}"`]);
    expect(problemsOf(changeRow(originals, name, () => ""))).toEqual([`UNDOCUMENTED: deployment variables: ${name}`]);
    expect(problemsOf(changeRow(originals, name, row => cell(row, COLUMN.default, "`https://templates.example/index.json`"))))
      .toEqual([`DEFAULT: ${where}: ${name}: expected "${DEFAULT}", found "https://templates.example/index.json"`]);
  });
});

describe("the satellite imagery's tile address and credit, stored on Libraries", () => {
  const satellite = ["DEZFIL_SATELLITE_URL", "DEZFIL_SATELLITE_ATTRIBUTION"];
  const where = "docs/self-host/configuration/libraries.md settings-libraries";

  it("are marked as changed in Settings or by their variables", () => {
    for (const name of satellite) expect(rowOf(originals, name).row, name).toContain(`| ${LIVE} |`);
  });

  it("rejects each marked as changed only by a restart, naming it alone", () => {
    for (const name of satellite) {
      expect(problemsOf(changeRow(originals, name, row => cell(row, COLUMN.changes, RESTART))), name)
        .toEqual([`CHANGES: ${where}: ${name}: expected "${LIVE}", found "${RESTART}"`]);
    }
  });
});

describe("the service addresses and numbers an admin stores on Data & services", () => {
  const variableOf = (key: string) => SETTING_CATALOGUE.find(definition => definition.key === key)!.environment!;
  const where = "docs/self-host/configuration/services.md settings-services";
  /** Every address and number the tab draws, by its variable. */
  const stored = [...addressRows(), ...serviceNumberRows()].map(row => variableOf(row.key));
  /** The services' settings that stay the environment's alone. */
  const fixed = ["DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS", "DEZFIL_GEOCODE_CACHE_MB", "DEZFIL_ISOCHRONE_CACHE_MB", "DEZFIL_OVERPASS_CACHE_MB",
    "DEZFIL_OVERPASS_MAXSIZE_MB", "DEZFIL_OBJECT_STORE_CREDENTIALS", "DEZFIL_EGRESS_ALLOWLIST"];

  it("are the four addresses and the eight numbers, each marked as changed in Settings or by its variable", () => {
    expect(stored).toEqual([
      "DEZFIL_GEOCODER_URL", "DEZFIL_ISOCHRONE_URL", "DEZFIL_OVERPASS_URL", "DEZFIL_S3_ENDPOINT",
      "DEZFIL_GEOCODE_PACE_MS", "DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", "DEZFIL_GEOCODE_MATCH_CACHE_HOURS",
      "DEZFIL_ISOCHRONE_PACE_MS", "DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S", "DEZFIL_ISOCHRONE_CACHE_HOURS",
      "DEZFIL_OVERPASS_TIMEOUT_S", "DEZFIL_OVERPASS_CACHE_H",
    ]);
    for (const name of stored) expect(rowOf(originals, name), name).toEqual({ page: "docs/self-host/configuration/services.md", row: expect.stringContaining(`| ${LIVE} |`) });
    for (const name of fixed) expect(rowOf(originals, name), name).toEqual({ page: "docs/self-host/configuration/services.md", row: expect.stringContaining(`| ${RESTART} |`) });
  });

  it("rejects each of them marked as changed only by a restart, naming it alone", () => {
    for (const name of stored) {
      expect(problemsOf(changeRow(originals, name, row => cell(row, COLUMN.changes, RESTART))), name)
        .toEqual([`CHANGES: ${where}: ${name}: expected "${LIVE}", found "${RESTART}"`]);
    }
  });

  it("rejects a service setting the environment alone sets marked as changed in Settings", () => {
    for (const name of fixed) {
      expect(problemsOf(changeRow(originals, name, row => cell(row, COLUMN.changes, LIVE))), name)
        .toEqual([`CHANGES: ${where}: ${name}: expected "${RESTART}", found "${LIVE}"`]);
    }
  });

  it("rejects the tables as they read before an admin could store these, every mark", () => {
    const before = stored.reduce((documents, name) => changeRow(documents, name, row => cell(row, COLUMN.changes, RESTART)), originals);
    expect(problemsOf(before)).toHaveLength(stored.length);
    const result = check(changeRow(originals, "DEZFIL_GEOCODER_URL", row => cell(row, COLUMN.changes, RESTART)));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output)).toEqual([`CHANGES: ${where}: DEZFIL_GEOCODER_URL: expected "${LIVE}", found "${RESTART}"`]);
  });

  it("rejects a stored address's row lost, or its default changed", () => {
    expect(problemsOf(changeRow(originals, "DEZFIL_ISOCHRONE_URL", () => ""))).toEqual(["UNDOCUMENTED: deployment variables: DEZFIL_ISOCHRONE_URL"]);
    expect(problemsOf(changeRow(originals, "DEZFIL_OVERPASS_URL", row => cell(row, COLUMN.default, "`https://overpass.example/api/interpreter`"))))
      .toEqual([`DEFAULT: ${where}: DEZFIL_OVERPASS_URL: expected "https://overpass-api.de/api/interpreter", found "https://overpass.example/api/interpreter"`]);
  });
});
