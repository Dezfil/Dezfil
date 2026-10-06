import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { SETTING_CATALOGUE, TEST_WIRING } from "./settings/catalogue";
import { configurationProblems } from "../../scripts/check-readme-config.mjs";

const root = process.cwd();
const scratch = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "configuration-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const guides = ["README.md", "docs/configuration.md"] as const;
const originals = Object.fromEntries(guides.map(file => [file, readFileSync(path.join(root, file), "utf8")]));
const variable = "DEZFIL_UPLOAD_MAX_MB";
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
  expect(result.output).toContain("63 deployment settings");
  expect(result.output).toContain("3 test-wiring names");
});

it("takes defaults and editability from the supplied catalogue, not a copy in the checker", () => {
  const catalogue = SETTING_CATALOGUE.map(definition => definition.key === "uploadMaxMb"
    ? { ...definition, documentedDefault: "777", editable: false, timing: "next-start" as const } : definition);
  const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals, catalogue, testWiring: TEST_WIRING });
  expect(problems).toHaveLength(4);
  for (const guide of guides) {
    expect(problems).toContainEqual(expect.stringContaining(`DEFAULT: ${guide}: ${variable}: expected "777"`));
    expect(problems).toContainEqual(expect.stringContaining(`CHANGED BY: ${guide}: ${variable}: expected "Restart"`));
  }
});

it("rejects deployment and test-wiring names removed from the catalogue while reads remain", () => {
  const problems = configurationProblems({ srcDir: path.join(root, "src"), documents: originals,
    catalogue: SETTING_CATALOGUE.filter(definition => definition.environment !== variable), testWiring: TEST_WIRING.slice(1),
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
