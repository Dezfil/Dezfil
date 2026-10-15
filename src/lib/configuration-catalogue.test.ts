import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { isLibrarySwitch, isTemplatesSetting, SETTING_CATALOGUE, TEST_WIRING } from "./settings/catalogue";
import { isInstanceDefault } from "./settings/instance-defaults";
import { isInstanceRule } from "./settings/instance-security";
import { configurationProblems, configurationRows } from "../../scripts/check-readme-config.mjs";
import { addressRows, serviceNumberRows } from "@/components/settings/data-table";

const root = process.cwd();
const scratch = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "configuration-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const guides = ["README.md", "docs/configuration.md"] as const;
const originals = Object.fromEntries(guides.map(file => [file, readFileSync(path.join(root, file), "utf8")]));
const variable = "DEZFIL_UPLOAD_MAX_MB";
/** The guide whose Instance defaults table the check holds to the catalogue's defaults. */
const defaultsGuide = "docs/configuration.md";
function changeRow(text: string, name: string, change: (row: string) => string) {
  const row = text.split("\n").find(line => line.startsWith(`| \`${name}\` |`));
  expect(row, `seed target ${name}`).toBeDefined();
  const changed = text.replace(row!, change(row!));
  expect(changed, "the seed must alter the document").not.toBe(text);
  return changed;
}
function cell(row: string, position: number, value: string) {
  const cells = row.split("|"); cells[position] = ` ${value} `; return cells.join("|");
}
function check(file?: string, mutate?: (text: string) => string) {
  const run = mkdtempSync(path.join(scratch, "run-"));
  const readme = path.join(run, "README.md"), configuration = path.join(run, "configuration.md");
  for (const [name, destination] of [["README.md", readme], ["docs/configuration.md", configuration]]) {
    writeFileSync(destination, file === name ? mutate!(originals[name]) : originals[name]);
  }
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-readme-config.mjs"),
    "--readme", readme, "--configuration", configuration], {
    encoding: "utf8", env: { ...process.env, DEZFIL_DATA_DIR: run },
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

it("checks both real documents against the catalogue and retains the script wiring check", () => {
  const result = check();
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("68 deployment settings");
  expect(result.output).toContain("4 test-wiring names");
  expect(result.output).toContain("18 instance defaults");
  expect(result.output).toContain("12 rules");
  expect(result.output).toContain("5 basemap switches");
  expect(result.output).toContain("1 template setting");
});

it("takes defaults and editability from the supplied catalogue, not a copy in the checker", () => {
  const catalogue = SETTING_CATALOGUE.map(definition => definition.key === "uploadMaxMb"
    ? { ...definition, documentedDefault: "777", editable: false, timing: "next-start" as const } : definition);
  const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
  expect(problems).toHaveLength(4);
  for (const guide of guides) {
    expect(problems).toContainEqual(expect.stringContaining(`DEFAULT: ${guide}: ${variable}: expected "777"`));
    expect(problems).toContainEqual(expect.stringContaining(`CHANGED BY: ${guide}: ${variable}: expected "Restart"`));
  }
});

it("rejects deployment and test-wiring names removed from the catalogue while reads remain", () => {
  const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals,
    catalogue: SETTING_CATALOGUE.filter(definition => definition.environment !== variable), testWiring: TEST_WIRING.slice(1), defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting,
  });
  for (const name of [variable, TEST_WIRING[0].environment]) {
    expect(problems).toContain(`STALE: source scan against catalogue: ${name}`);
    for (const guide of guides) expect(problems).toContainEqual(expect.stringMatching(`STALE: ${guide}.*: ${name}`));
  }
});

describe.each(guides)("%s catalogue drift", file => {
  const seeds: [string, (text: string) => string, string][] = [
    ["missing deployment row", text => changeRow(text, variable, () => ""), "UNDOCUMENTED"],
    ["orphan deployment row", text => `${text}\n| \`DEZFIL_ORPHAN_SETTING\` | 1 | Orphan. | Restart |\n`, "STALE"],
    ["wrong default", text => changeRow(text, variable, row => cell(row, 2, "999")), "DEFAULT"],
    ["missing editable mark", text => changeRow(text, variable, row => cell(row, 4, "Restart")), "CHANGED BY"],
    ["false editable mark", text => changeRow(text, "DEZFIL_QUERY_MEMORY_MB", row => cell(row, 4, "App (live) or restart")), "CHANGED BY"],
    ["wrong timing", text => changeRow(text, variable, row => cell(row, 4, "App (after restart) or restart")), "CHANGED BY"],
    ["duplicate row", text => changeRow(text, variable, row => `${row}\n${row}`), "DUPLICATE"],
    ["missing change column", text => text.replaceAll("| Changed by |", "| How changed |"), "CHANGED BY"],
  ];
  it.each(seeds)("rejects seeded %s independently", (_label, seed, diagnostic) => {
    const result = check(file, seed);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(diagnostic);
    expect(result.output).toContain(path.basename(file));
  });
  it.each(TEST_WIRING)("rejects removal of test wiring $environment", ({ environment }) => {
    const result = check(file, text => changeRow(text, environment, () => ""));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(environment);
  });
  it("rejects an orphan test-wiring row", () => {
    const result = check(file, text => `${text}\n| \`DEZFIL_TEST_ORPHAN\` | unset | Orphan. | Restart |\n`);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("DEZFIL_TEST_ORPHAN");
  });
});

describe("the test seams the product code reads", () => {
  const seam = "DEZFIL_TEST_EXTENSION_REPOSITORY";
  const problemsOf = (srcDir: string, testWiring: readonly { environment: string; documentedDefault: string }[] = TEST_WIRING) =>
    configurationProblems({ srcDir, documents: originals, catalogue: SETTING_CATALOGUE, testWiring, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });

  it("hold the engine's extension repository as test wiring, unset by default, in both guides", () => {
    expect(TEST_WIRING.map(wiring => wiring.environment)).toContain(seam);
    for (const guide of guides) {
      expect(configurationRows(originals[guide]).filter(row => row.name === seam), guide).toEqual([{ name: seam, defaultValue: "unset", changedBy: "Restart" }]);
    }
    expect(problemsOf(path.join(root, "src"))).toEqual([]);
  });

  it("rejects the seam taken from the catalogue while the engine still reads it", () => {
    const problems = problemsOf(path.join(root, "src"), TEST_WIRING.filter(wiring => wiring.environment !== seam));
    expect(problems).toContain(`STALE: source scan against catalogue: ${seam}`);
    expect(problems).toContain(`STALE: test wiring reads against catalogue: ${seam}`);
    for (const guide of guides) expect(problems).toContain(`STALE: ${guide} test wiring: ${seam}`);
  });

  it("rejects a seam the product code reads that the catalogue and the guides do not name, and leaves one a test file reads to that file", () => {
    const src = mkdtempSync(path.join(scratch, "src-"));
    writeFileSync(path.join(src, "engine.ts"), "export const repository = process.env.DEZFIL_TEST_NEW_SEAM;\n");
    writeFileSync(path.join(src, "engine.test.ts"), "export const local = process.env.DEZFIL_TEST_FILE_LOCAL;\n");
    const problems = problemsOf(src);
    expect(problems.filter(problem => problem.includes("DEZFIL_TEST_NEW_SEAM")).sort()).toEqual([
      "STALE: source scan against catalogue: DEZFIL_TEST_NEW_SEAM",
      "STALE: test wiring reads against catalogue: DEZFIL_TEST_NEW_SEAM",
      "UNDOCUMENTED: README.md test wiring reads: DEZFIL_TEST_NEW_SEAM",
      "UNDOCUMENTED: docs/configuration.md test wiring reads: DEZFIL_TEST_NEW_SEAM",
    ]);
    expect(problems.filter(problem => problem.includes("DEZFIL_TEST_FILE_LOCAL"))).toEqual([]);
  });
});

describe("the configuration guide's Instance defaults table", () => {
  const key = "newLayer.lineOpacity";
  /** The guide with one row taken out whole, so the table around it stays one table. */
  const without = (text: string, name: string) => {
    const changed = changeRow(text, name, () => "\0");
    return changed.replace("\0\n", "");
  };
  /** What the check reported, one problem a line, without the run's folder or the closing count. */
  const reported = (output: string) => output.split("\n").filter(line => /^[A-Z ]+: /.test(line) && !line.startsWith("FAIL"))
    .map(line => line.replace(/\S*configuration\.md/, "configuration.md"));
  const seeds: [string, (text: string) => string, string][] = [
    ["missing default row", text => without(text, key), `UNDOCUMENTED: configuration.md instance defaults: ${key}`],
    ["orphan default row", text => changeRow(text, key, row => `${row}\n| \`newLayer.haloWidth\` | A number from 0 to 4 | \`1\` | Orphan. |`),
      "STALE: configuration.md instance defaults: newLayer.haloWidth"],
    ["wrong default", text => changeRow(text, key, row => cell(row, 3, "`90`")),
      `DEFAULT: configuration.md instance defaults: ${key}: expected "95", found "90"`],
    ["duplicate default row", text => changeRow(text, key, row => `${row}\n${row}`), `DUPLICATE: configuration.md instance defaults: ${key}`],
  ];

  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problem) => {
    const result = check(defaultsGuide, seed);
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output)).toEqual([problem]);
  });

  it("rejects the table whose default column is lost, a default at a time", () => {
    const result = check(defaultsGuide, text => text.replace("| Setting | Values | Default | Taken when |", "| Setting | Values | Starts as | Taken when |"));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).filter(line => line.startsWith("DEFAULT: configuration.md instance defaults: "))).toHaveLength(18);
  });

  it("rejects a guide that has lost the table, naming every default", () => {
    const result = check(defaultsGuide, text => text.replace("## Instance defaults", "## Starting values"));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).filter(line => line.startsWith("UNDOCUMENTED: configuration.md instance defaults: "))).toHaveLength(18);
  });

  it("holds the table to the supplied catalogue's defaults, not a copy in the checker", () => {
    const opens = SETTING_CATALOGUE.find(definition => definition.key === "canvas.opens")!;
    const catalogue = [
      ...SETTING_CATALOGUE.filter(definition => definition.key !== "canvas.resultsBand")
        .map(definition => definition.key === "newMap.zoom" ? { ...definition, documentedDefault: "2" } : definition),
      { ...opens, key: "canvas.snap", documentedDefault: "on" },
    ];
    const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
    expect([...problems].sort()).toEqual([
      'DEFAULT: docs/configuration.md instance defaults: newMap.zoom: expected "2", found "1.3"',
      "STALE: docs/configuration.md instance defaults: canvas.resultsBand",
      "UNDOCUMENTED: docs/configuration.md instance defaults: canvas.snap",
    ]);
  });
});

describe("the configuration guide's Security and rules table", () => {
  const key = "security.passwordMin";
  const without = (text: string, name: string) => changeRow(text, name, () => "\0").replace("\0\n", "");
  const reported = (output: string) => output.split("\n").filter(line => /^[A-Z ]+: /.test(line) && !line.startsWith("FAIL"))
    .map(line => line.replace(/\S*configuration\.md/, "configuration.md"));
  const seeds: [string, (text: string) => string, string[]][] = [
    ["missing rule row", text => without(text, key), [`UNDOCUMENTED: configuration.md security and rules: ${key}`]],
    ["orphan rule row", text => changeRow(text, key, row => `${row}\n| \`security.twoFactor\` | \`off\`, \`on\` | \`off\` | Orphan. |`),
      ["STALE: configuration.md security and rules: security.twoFactor"]],
    ["wrong default", text => changeRow(text, key, row => cell(row, 3, "`12`")),
      [`DEFAULT: configuration.md security and rules: ${key}: expected "8", found "12"`]],
    ["wrong list default", text => changeRow(text, "publishing.embedSites", row => cell(row, 3, "`https://www.stadtwerke.example`")),
      ['DEFAULT: configuration.md security and rules: publishing.embedSites: expected "none", found "https://www.stadtwerke.example"']],
    ["duplicate rule row", text => changeRow(text, key, row => `${row}\n${row}`), [`DUPLICATE: configuration.md security and rules: ${key}`]],
    ["rule row moved under the defaults", text => changeRow(without(text, "imports.links"), "imageExport.shape",
      row => `${row}\n| \`imports.links\` | \`everyone\`, \`admins\` | \`everyone\` | Moved. |`), [
      "STALE: configuration.md instance defaults: imports.links", "UNDOCUMENTED: configuration.md security and rules: imports.links"]],
  ];

  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problems) => {
    const result = check(defaultsGuide, seed);
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).sort()).toEqual(problems);
  });

  it("rejects a guide that has lost the table, naming every rule", () => {
    const result = check(defaultsGuide, text => text.replace("## Security and rules", "## Access"));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).filter(line => line.startsWith("UNDOCUMENTED: configuration.md security and rules: "))).toHaveLength(12);
  });

  it("holds the table to the supplied catalogue's rules, not a copy in the checker", () => {
    const create = SETTING_CATALOGUE.find(definition => definition.key === "tokens.create")!;
    const catalogue = [
      ...SETTING_CATALOGUE.filter(definition => definition.key !== "imports.links")
        .map(definition => definition.key === "security.linkDays" ? { ...definition, documentedDefault: "14" } : definition),
      { ...create, key: "tokens.scopes", documentedDefault: "read" },
    ];
    const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
    expect([...problems].sort()).toEqual([
      'DEFAULT: docs/configuration.md security and rules: security.linkDays: expected "14", found "7"',
      "STALE: docs/configuration.md security and rules: imports.links",
      "UNDOCUMENTED: docs/configuration.md security and rules: tokens.scopes",
    ]);
  });

  it("counts the stored sign-in, token, publishing, connection and import settings, and nothing else, as rules", () => {
    const rules = SETTING_CATALOGUE.filter(definition => isInstanceRule(definition)).map(definition => definition.key);
    expect(rules).toEqual([
      "security.sessionDays", "security.linkDays", "security.failedPerAccount", "security.failedPerAddress", "security.passwordMin",
      "tokens.create", "tokens.expiry", "publishing.publish", "publishing.embedding", "publishing.embedSites",
      "connections.create", "imports.links",
    ]);
    expect(SETTING_CATALOGUE.filter(definition => isInstanceRule(definition) && isInstanceDefault(definition))).toEqual([]);
  });
});

describe("the configuration guide's Libraries table", () => {
  const key = "basemaps.streets";
  const without = (text: string, name: string) => changeRow(text, name, () => "\0").replace("\0\n", "");
  const reported = (output: string) => output.split("\n").filter(line => /^[A-Z ]+: /.test(line) && !line.startsWith("FAIL"))
    .map(line => line.replace(/\S*configuration\.md/, "configuration.md"));
  const seeds: [string, (text: string) => string, string[]][] = [
    ["missing switch row", text => without(text, key), [`UNDOCUMENTED: configuration.md libraries: ${key}`]],
    ["orphan switch row", text => changeRow(text, key, row => `${row}\n| \`basemaps.terrain\` | \`true\` or \`false\` | on | Orphan. |`),
      ["STALE: configuration.md libraries: basemaps.terrain"]],
    ["wrong default", text => changeRow(text, key, row => cell(row, 3, "off")), [`DEFAULT: configuration.md libraries: ${key}: expected "on", found "off"`]],
    ["duplicate switch row", text => changeRow(text, key, row => `${row}\n${row}`), [`DUPLICATE: configuration.md libraries: ${key}`]],
    ["switch row moved under the rules", text => changeRow(without(text, "basemaps.singleMapStyles"), "imports.links",
      row => `${row}\n| \`basemaps.singleMapStyles\` | \`true\` or \`false\` | on | Moved. |`), [
      "STALE: configuration.md security and rules: basemaps.singleMapStyles", "UNDOCUMENTED: configuration.md libraries: basemaps.singleMapStyles"]],
  ];

  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problems) => {
    const result = check(defaultsGuide, seed);
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).sort()).toEqual(problems);
  });

  it("rejects a guide that has lost the section, naming every switch", () => {
    const result = check(defaultsGuide, text => text.replace("## Libraries", "## Basemaps and palettes"));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).filter(line => line.startsWith("UNDOCUMENTED: configuration.md libraries: "))).toHaveLength(5);
  });

  it("holds the table to the supplied catalogue's switches, not a copy in the checker", () => {
    const dark = SETTING_CATALOGUE.find(definition => definition.key === "basemaps.dark")!;
    const catalogue = [
      ...SETTING_CATALOGUE.filter(definition => definition.key !== "basemaps.light")
        .map(definition => definition.key === "basemaps.streets" ? { ...definition, documentedDefault: "off" } : definition),
      { ...dark, key: "basemaps.terrain" },
    ];
    const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
    expect([...problems].sort()).toEqual([
      'DEFAULT: docs/configuration.md libraries: basemaps.streets: expected "off", found "on"',
      "STALE: docs/configuration.md libraries: basemaps.light",
      "UNDOCUMENTED: docs/configuration.md libraries: basemaps.terrain",
    ]);
  });

  it("counts the five basemap switches, and nothing else, as the Libraries rows", () => {
    expect(SETTING_CATALOGUE.filter(definition => isLibrarySwitch(definition)).map(definition => definition.key)).toEqual([
      "basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles",
    ]);
    expect(SETTING_CATALOGUE.filter(definition => isLibrarySwitch(definition) && (isInstanceDefault(definition) || isInstanceRule(definition)))).toEqual([]);
  });

  it("refuses a check without the catalogue's Libraries predicate", () => {
    expect(() => configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING,
      defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch: undefined, isTemplatesSetting })).toThrow("isLibrarySwitch");
  });
});

describe("the configuration guide's Templates table", () => {
  const key = "templates.catalogue";
  const without = (text: string, name: string) => changeRow(text, name, () => "\0").replace("\0\n", "");
  const reported = (output: string) => output.split("\n").filter(line => /^[A-Z ]+: /.test(line) && !line.startsWith("FAIL"))
    .map(line => line.replace(/\S*configuration\.md/, "configuration.md"));
  const seeds: [string, (text: string) => string, string[]][] = [
    ["missing switch row", text => without(text, key), [`UNDOCUMENTED: configuration.md templates: ${key}`]],
    ["orphan row", text => changeRow(text, key, row => `${row}\n| \`templates.autoFetch\` | \`true\` or \`false\` | off | Orphan. |`),
      ["STALE: configuration.md templates: templates.autoFetch"]],
    ["wrong default", text => changeRow(text, key, row => cell(row, 3, "off")), [`DEFAULT: configuration.md templates: ${key}: expected "on", found "off"`]],
    ["duplicate switch row", text => changeRow(text, key, row => `${row}\n${row}`), [`DUPLICATE: configuration.md templates: ${key}`]],
    ["switch row moved under the libraries", text => changeRow(without(text, key), "basemaps.streets",
      row => `${row}\n| \`templates.catalogue\` | \`true\` or \`false\` | on | Moved. |`), [
      "STALE: configuration.md libraries: templates.catalogue", "UNDOCUMENTED: configuration.md templates: templates.catalogue"]],
  ];

  it.each(seeds)("rejects seeded %s, naming only it", (_label, seed, problems) => {
    const result = check(defaultsGuide, seed);
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output).sort()).toEqual(problems);
  });

  it("rejects a guide that has lost the section, naming the switch", () => {
    const result = check(defaultsGuide, text => text.replace("## Templates", "## Examples"));
    expect(result.status, result.output).toBe(1);
    expect(reported(result.output)).toEqual(["UNDOCUMENTED: configuration.md templates: templates.catalogue"]);
  });

  it("holds the table to the supplied catalogue's template settings, not a copy in the checker", () => {
    const use = SETTING_CATALOGUE.find(definition => definition.key === key)!;
    const catalogue = [
      ...SETTING_CATALOGUE.map(definition => definition.key === key ? { ...definition, documentedDefault: "off" } : definition),
      { ...use, key: "templates.autoFetch" },
    ];
    const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
    expect([...problems].sort()).toEqual([
      'DEFAULT: docs/configuration.md templates: templates.catalogue: expected "off", found "on"',
      "UNDOCUMENTED: docs/configuration.md templates: templates.autoFetch",
    ]);
  });

  it("counts the catalogue switch, and nothing else, as the Templates rows", () => {
    expect(SETTING_CATALOGUE.filter(definition => isTemplatesSetting(definition)).map(definition => definition.key)).toEqual([key]);
    expect(SETTING_CATALOGUE.filter(definition => isTemplatesSetting(definition) &&
      (isInstanceDefault(definition) || isInstanceRule(definition) || isLibrarySwitch(definition)))).toEqual([]);
  });

  it("refuses a check without the catalogue's Templates predicate", () => {
    expect(() => configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING,
      defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting: undefined })).toThrow("isTemplatesSetting");
  });
});

describe("the template catalogue's address, stored on Data & services", () => {
  const LIVE = "App (live) or restart";
  const name = "DEZFIL_TEMPLATES_CATALOGUE";
  const problemsOf = (documents: Record<string, string>) => configurationProblems({ srcDir: path.join(root, "src"), documents,
    catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
  const DEFAULT = "https://github.com/Dezfil/templates/releases/latest/download/index.json";

  it("is marked as changed in the app in both guides, with the release catalogue as its default", () => {
    for (const guide of guides) {
      expect(configurationRows(originals[guide]).filter(row => row.name === name), guide).toEqual([{ name, defaultValue: DEFAULT, changedBy: LIVE }]);
    }
  });

  it.each(guides)("rejects it marked as changed only by a restart, lost, or with another default in %s, naming it alone", guide => {
    expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, row => cell(row, 4, "Restart")) }))
      .toEqual([`CHANGED BY: ${guide}: ${name}: expected "${LIVE}", found "Restart"`]);
    expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, () => "\0").replace("\0\n", "") }))
      .toEqual([`UNDOCUMENTED: ${guide}: ${name}`]);
    expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, row => cell(row, 2, "`https://templates.example/index.json`")) }))
      .toEqual([`DEFAULT: ${guide}: ${name}: expected "${DEFAULT}", found "https://templates.example/index.json"`]);
  });
});

describe("the satellite imagery's tile address and credit, stored on Libraries", () => {
  const LIVE = "App (live) or restart";
  const satellite = ["DEZFIL_SATELLITE_URL", "DEZFIL_SATELLITE_ATTRIBUTION"];
  const problemsOf = (documents: Record<string, string>) => configurationProblems({ srcDir: path.join(root, "src"), documents,
    catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });

  it("are marked as changed in the app in both guides", () => {
    for (const guide of guides) {
      const rows = configurationRows(originals[guide]);
      for (const name of satellite) expect(rows.find(row => row.name === name)?.changedBy, `${guide}: ${name}`).toBe(LIVE);
    }
  });

  it.each(guides)("rejects each marked as changed only by a restart in %s, naming it alone", guide => {
    for (const name of satellite) {
      expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, row => cell(row, 4, "Restart")) }), name)
        .toEqual([`CHANGED BY: ${guide}: ${name}: expected "${LIVE}", found "Restart"`]);
    }
  });
});

describe("the service addresses and numbers an admin stores on Data & services", () => {
  const LIVE = "App (live) or restart";
  const srcDir = path.join(root, "src");
  const problemsOf = (documents: Record<string, string>) =>
    configurationProblems({ srcDir, documents, catalogue: SETTING_CATALOGUE, testWiring: TEST_WIRING, defaultsGuide, isInstanceDefault, isInstanceRule, isLibrarySwitch, isTemplatesSetting });
  const variableOf = (key: string) => SETTING_CATALOGUE.find(definition => definition.key === key)!.environment!;
  /** Every address and number the tab draws, by its variable. */
  const stored = [...addressRows(), ...serviceNumberRows()].map(row => variableOf(row.key));
  /** The services' settings that stay the environment's alone. */
  const fixed = ["DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS", "DEZFIL_GEOCODE_CACHE_MB", "DEZFIL_ISOCHRONE_CACHE_MB", "DEZFIL_OVERPASS_CACHE_MB",
    "DEZFIL_OVERPASS_MAXSIZE_MB", "DEZFIL_OVERTURE_S3_ENDPOINT", "DEZFIL_OBJECT_STORE_CREDENTIALS", "DEZFIL_EGRESS_ALLOWLIST"];

  it("are the four addresses and the eight numbers, each marked as changed in the app in both guides", () => {
    expect(stored).toEqual([
      "DEZFIL_GEOCODER_URL", "DEZFIL_ISOCHRONE_URL", "DEZFIL_OVERPASS_URL", "DEZFIL_S3_ENDPOINT",
      "DEZFIL_GEOCODE_PACE_MS", "DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", "DEZFIL_GEOCODE_MATCH_CACHE_HOURS",
      "DEZFIL_ISOCHRONE_PACE_MS", "DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S", "DEZFIL_ISOCHRONE_CACHE_HOURS",
      "DEZFIL_OVERPASS_TIMEOUT_S", "DEZFIL_OVERPASS_CACHE_H",
    ]);
    for (const guide of guides) {
      const rows = configurationRows(originals[guide]);
      for (const name of stored) expect(rows.find(row => row.name === name)?.changedBy, `${guide}: ${name}`).toBe(LIVE);
      for (const name of fixed) expect(rows.find(row => row.name === name)?.changedBy, `${guide}: ${name}`).toBe("Restart");
    }
  });

  it.each(guides)("rejects each of them marked as changed only by a restart in %s, naming it alone", guide => {
    for (const name of stored) {
      expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, row => cell(row, 4, "Restart")) }), name)
        .toEqual([`CHANGED BY: ${guide}: ${name}: expected "${LIVE}", found "Restart"`]);
    }
  });

  it.each(guides)("rejects a service setting the environment alone sets marked as changed in the app in %s", guide => {
    for (const name of fixed) {
      expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], name, row => cell(row, 4, LIVE)) }), name)
        .toEqual([`CHANGED BY: ${guide}: ${name}: expected "Restart", found "${LIVE}"`]);
    }
  });

  it("rejects both guides as they read before an admin could store these, every mark in each", () => {
    const before = Object.fromEntries(guides.map(guide => [guide,
      stored.reduce((text, name) => changeRow(text, name, row => cell(row, 4, "Restart")), originals[guide])]));
    expect(problemsOf(before)).toHaveLength(2 * stored.length);
    const result = check("docs/configuration.md", text => changeRow(text, "DEZFIL_GEOCODER_URL", row => cell(row, 4, "Restart")));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`CHANGED BY: ${result.output.match(/\S*configuration\.md/)![0]}: DEZFIL_GEOCODER_URL: expected "${LIVE}", found "Restart"`);
  });

  it("rejects a stored address's row lost, or its default changed, in either guide", () => {
    for (const guide of guides) {
      // The row taken out whole, so the table around it stays one table.
      expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], "DEZFIL_ISOCHRONE_URL", () => "\0").replace("\0\n", "") }))
        .toEqual([`UNDOCUMENTED: ${guide}: DEZFIL_ISOCHRONE_URL`]);
      expect(problemsOf({ ...originals, [guide]: changeRow(originals[guide], "DEZFIL_OVERPASS_URL", row => cell(row, 2, "`https://overpass.example/api/interpreter`")) }))
        .toEqual([`DEFAULT: ${guide}: DEZFIL_OVERPASS_URL: expected "https://overpass-api.de/api/interpreter", found "https://overpass.example/api/interpreter"`]);
    }
  });
});
