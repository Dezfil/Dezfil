// The settings tables are generated from the settings catalogue Settings
// reads, one per area, and `npm run lint:docs` holds each one in its page:
// present, once, on the page it belongs to, and as the catalogue generates
// it. Each rule is shown red by a seeded page.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as catalogue from "./settings/catalogue";
import * as limits from "@/components/settings/limits-table";
import * as general from "@/components/settings/general-table";
import * as defaults from "@/components/settings/defaults-table";
import * as libraries from "@/components/settings/libraries-table";
import * as data from "@/components/settings/data-table";
import * as security from "@/components/settings/security-table";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: a plain-JS gate, no declaration file on purpose.
import { SETTINGS_AREAS, SETTINGS_HEADER, TEST_SEAMS, WIRING_TABLE, areaOf, checkSettingsTables, settingsTables, tableRegions, writeSettingsTables } from "../../scripts/settings-tables.mjs";

type Problem = { file: string; rule: string; message: string; line?: number };
type Table = { id: string; page: string; table: string; names: string[]; markdown: string };
type Definition = (typeof catalogue.SETTING_CATALOGUE)[number];

const source = { catalogue, limits, general, defaults, libraries, data, security };
const tables = settingsTables(source) as Table[];
const byTable = (name: string) => tables.find((entry) => entry.table === name)!;
const shape = (problems: Problem[]) => problems.map(({ file, rule }) => ({ file, rule }));

/** The repository's files, as the lint lists them. */
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
const read = (file: string) => readFileSync(file, "utf8");

/** One row of a table, by the variable or Settings key it names, as cells. */
function row(table: string, name: string): string[] {
  const line = byTable(table).markdown.split("\n").find((entry) => entry.includes(`\`${name}\``));
  expect(line, `${table}: ${name}`).toBeDefined();
  return line!.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
}

describe("the settings tables", () => {
  it("list every instance setting once, and leave out an account's own preferences and the platform's plumbing", () => {
    const listed = tables.flatMap((entry) => entry.names);
    const instance = catalogue.SETTING_CATALOGUE.filter((definition) => definition.scope === "instance");
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...instance.map((definition) => definition.environment ?? definition.key), ...catalogue.TEST_WIRING.map((wiring) => wiring.environment)].sort());
    for (const definition of catalogue.SETTING_CATALOGUE.filter((d) => d.scope !== "instance")) {
      expect(areaOf(definition, catalogue), definition.key).toBeNull();
      expect(listed).not.toContain(definition.environment ?? definition.key);
    }
  });

  it("put the assistant's on Set up the assistant, the trusted proxies' on Reverse proxy and HTTPS, the limits on Limits, the rest under Configuration", () => {
    expect(Object.fromEntries(tables.map((entry) => [entry.table, entry.page]))).toEqual({
      "settings-general": "docs/self-host/configuration/general.md",
      "settings-defaults": "docs/self-host/configuration/defaults.md",
      "settings-libraries": "docs/self-host/configuration/libraries.md",
      "settings-services": "docs/self-host/configuration/services.md",
      "settings-rules": "docs/self-host/configuration/rules.md",
      "settings-storage": "docs/self-host/configuration/storage.md",
      "settings-assistant": "docs/self-host/assistant.md",
      "settings-proxies": "docs/self-host/reverse-proxy.md",
      "settings-limits": "docs/api/limits.md",
      "test-wiring": "docs/contribute/development-setup.md",
    });
    expect(byTable("settings-proxies").names).toEqual(["DEZFIL_TRUSTED_PROXIES", "DEZFIL_SESSION_COOKIE"]);
    expect(byTable("settings-assistant").names).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEZFIL_AI_PROVIDER", "DEZFIL_ASSISTANT_STEP_BUDGET"]));
  });

  it("follow the catalogue's own groups for what new things start with, the rules, the basemap switches and the template catalogue", () => {
    const keys = (table: string) => new Set(byTable(table).names);
    for (const definition of catalogue.SETTING_CATALOGUE) {
      if (catalogue.isInstanceDefault(definition)) expect(keys("settings-defaults").has(definition.key), definition.key).toBe(true);
      if (catalogue.isInstanceRule(definition)) expect(keys("settings-rules").has(definition.key), definition.key).toBe(true);
      if (catalogue.isLibrarySwitch(definition)) expect(keys("settings-libraries").has(definition.key), definition.key).toBe(true);
      if (catalogue.isTemplatesSetting(definition)) expect(keys("settings-services").has(definition.key), definition.key).toBe(true);
    }
    expect(byTable("settings-defaults").names).toHaveLength(catalogue.SETTING_CATALOGUE.filter((d) => catalogue.isInstanceDefault(d)).length);
    expect(byTable("settings-rules").names).toHaveLength(catalogue.SETTING_CATALOGUE.filter((d) => catalogue.isInstanceRule(d)).length);
  });

  it("put the catalogue's test seams with the test wiring on Development setup, and no other table lists them", () => {
    expect(TEST_SEAMS).toEqual(["overtureS3Endpoint"]);
    expect(byTable(WIRING_TABLE.table).names).toEqual([...catalogue.TEST_WIRING.map((wiring) => wiring.environment), "DEZFIL_OVERTURE_S3_ENDPOINT"]);
    for (const entry of tables.filter((t) => t.table !== WIRING_TABLE.table)) expect(entry.names).not.toContain("DEZFIL_OVERTURE_S3_ENDPOINT");
  });

  it("list the Limits tab's rows in its order, under its labels, before the limits a variable alone sets", () => {
    const tab = limits.LIMITS_CARDS.flatMap((card) => card.rows).flatMap((entry) => entry.kind === "setting" ? [catalogue.settingDefinition(entry.key).environment] : []);
    expect(byTable("settings-limits").names.slice(0, tab.length)).toEqual(tab);
    expect(row("settings-limits", "DEZFIL_OPERATION_CONCURRENCY")[0]).toBe("**Tools running at once**");
    expect(row("settings-limits", "DEZFIL_PUBLIC_RATE_LIMIT")[3]).toBe("`60` every 10 seconds");
  });

  it("name each setting a tab draws as that tab shows it, its card in front where the label is one word or names more than one row", () => {
    expect(row("settings-general", "signInMessage")[0]).toBe("**Sign-in** › **Message**");
    expect(row("settings-general", "lostPasswordContact")[0]).toBe("**Lost password contact**");
    expect(row("settings-defaults", "newMap.latitude")[0]).toBe("**Starting view** › **Latitude**");
    expect(row("settings-defaults", "newLayer.pointOpacity")[0]).toBe("**Opacity** › **Points**");
    expect(row("settings-defaults", "canvas.minimap")[0]).toBe("**Workflow canvas** › **Minimap**");
    expect(row("settings-defaults", "sqlConsole.textSize")[0]).toBe("**Text size**");
    expect(row("settings-libraries", "DEZFIL_SATELLITE_URL")[0]).toBe("**Tile address**");
    expect(row("settings-libraries", "DEZFIL_SATELLITE_ATTRIBUTION")[0]).toBe("**Satellite imagery** › **Credit**");
    expect(row("settings-services", "DEZFIL_GEOCODE_PACE_MS")[0]).toBe("**Address finder** › **Gap between requests**");
    expect(row("settings-services", "DEZFIL_ISOCHRONE_URL")[0]).toBe("**Travel time** › **Address**");
    expect(row("settings-services", "DEZFIL_EGRESS_ALLOWLIST")[0]).toBe("**Hosts the server may reach**");
    expect(row("settings-rules", "security.failedPerAccount")[0]).toBe("**Failed sign-ins before a pause** › **Per account**");
    expect(row("settings-rules", "publishing.embedSites")[0]).toBe("**Embedding on other sites** › **Listed sites**");
    // A setting no tab draws, which a variable alone sets, keeps System's name for it.
    expect(row("settings-services", "DEZFIL_GEOCODE_CACHE_MB")[0]).toBe("**Address cache size**");
    expect(row("settings-storage", "DEZFIL_DATA_DIR")[0]).toBe("**Data directory**");
  });

  it("take each label from the tab's own rows, and refuse a setting Settings changes that no tab draws", () => {
    const relabelled = { ...defaults, DEFAULTS_TABS: { ...defaults.DEFAULTS_TABS, workflows: defaults.DEFAULTS_TABS.workflows.map((card) => ({
      ...card, rows: card.rows.map((entry) => (entry.id === "set-sql-text-size" ? { ...entry, label: "Editor text size" } : entry)),
    })) } };
    const moved = settingsTables({ ...source, defaults: relabelled }) as Table[];
    expect(moved.find((t) => t.table === "settings-defaults")!.markdown).toContain("| **Editor text size** |  | `sqlConsole.textSize` |");
    const undrawn = { ...defaults, DEFAULTS_TABS: { ...defaults.DEFAULTS_TABS, workflows: defaults.DEFAULTS_TABS.workflows.map((card) => ({
      ...card, rows: card.rows.filter((entry) => entry.id !== "set-sql-text-size"),
    })) } };
    expect(() => settingsTables({ ...source, defaults: undrawn })).toThrow(/sqlConsole\.textSize/);
  });

  it("give each row its setting, variable, Settings key, default with its unit, values, purpose and change timing", () => {
    expect(SETTINGS_HEADER).toEqual(["Setting", "Variable", "Settings key", "Default", "Values", "What it does", "Changes"]);
    expect(row("settings-limits", "DEZFIL_UPLOAD_MAX_MB")).toEqual([
      "**Largest upload**", "`DEZFIL_UPLOAD_MAX_MB`", "`uploadMaxMb`", "`5120` MB",
      "1 to 102,400 in Settings; any number above 0 as a variable", "Size cap for one uploaded file.", "In Settings, live; by variable, after a restart",
    ]);
    // A variable alone: no Settings key, and a restart.
    expect(row("settings-limits", "DEZFIL_RENDER_CAP_FEATURES")).toEqual([
      "**Features drawn per layer**", "`DEZFIL_RENDER_CAP_FEATURES`", "", "`250000` features", "Any number above 0",
      "Feature cap for rendering and the point-layer tile threshold.", "By variable, after a restart",
    ]);
    // Settings alone: no variable, and live.
    expect(row("settings-rules", "security.sessionDays")).toEqual([
      "**Stay signed in for**", "", "`security.sessionDays`", "`30` days", "`1`, `7`, `30` or `90`",
      "How long a session lasts after its last use. A session keeps the expiry it holds; its next use renews it by this length.", "In Settings, live",
    ]);
    // Words about a default stay words; the value itself is code.
    expect(row("settings-storage", "DEZFIL_SECRET_KEY")[3]).toBe("generated");
    expect(row("settings-services", "DEZFIL_OVERPASS_URL")[3]).toBe("`https://overpass-api.de/api/interpreter`");
    expect(row("settings-libraries", "DEZFIL_SATELLITE_URL")[4]).toBe(
      "An `http` or `https` address, up to 2,048 characters, holding `{z}`, `{x}` and `{y}`, with no user name or password, in Settings; any address as a variable");
    expect(row("settings-services", "DEZFIL_TEMPLATES_CATALOGUE")[4]).toMatch(/, in Settings; any address, or a folder on the server, as a variable$/);
    expect(row("settings-proxies", "DEZFIL_SESSION_COOKIE")[4]).toBe("ASCII letters, digits and ``!#$%&'*+-.^_`\\|~``; any other value stops the server at start");
  });

  it("give Settings' rule for what Settings takes, in the unit its tab takes, apart from what a variable takes", () => {
    // The tab types the gap in seconds and the address freshness in days; the variable and the API keep milliseconds and hours.
    expect(row("settings-services", "DEZFIL_GEOCODE_PACE_MS")[4]).toBe("0 to 60 seconds in Settings; any number from 0, in milliseconds, as a variable");
    expect(row("settings-services", "DEZFIL_GEOCODE_MATCH_CACHE_HOURS")[4]).toBe("1 to 365 days in Settings; any number above 0, in hours, as a variable");
    expect(row("settings-services", "DEZFIL_ISOCHRONE_CACHE_HOURS")[4]).toBe("1 to 365 days in Settings; any number above 0, in hours, as a variable");
    // A unit the tab shares with the variable is said once, in the Default column.
    expect(row("settings-services", "DEZFIL_OVERPASS_CACHE_H")[4]).toBe("1 to 720 in Settings; any number above 0 as a variable");
    // Settings' length and form rules do not bind a variable, which is taken trimmed.
    expect(row("settings-libraries", "DEZFIL_SATELLITE_ATTRIBUTION")[4]).toBe("Text, up to 160 characters, in Settings; any text as a variable");
    expect(row("settings-services", "DEZFIL_GEOCODER_URL")[4]).toBe("An `http` or `https` address, up to 2,048 characters, in Settings; any address as a variable");
    // A setting Settings alone changes keeps its rule as it is.
    expect(row("settings-general", "signInMessage")[4]).toBe("Text, up to 280 characters");
  });

  it("refuse a setting no area takes, and a variable whose values are not described", () => {
    const base = catalogue.settingDefinition("basemapAttribution");
    const stray: Definition = { ...base, key: "strayText", environment: "DEZFIL_STRAY_TEXT" };
    expect(() => settingsTables({ ...source, catalogue: { ...catalogue, SETTING_CATALOGUE: [...catalogue.SETTING_CATALOGUE, stray] } })).toThrow(/DEZFIL_STRAY_TEXT/);
    const number = catalogue.settingDefinition("tileBuildTimeoutS");
    const limit: Definition = { ...number, key: "strayLimitS", environment: "DEZFIL_STRAY_LIMIT_S" };
    const widened = settingsTables({ ...source, catalogue: { ...catalogue, SETTING_CATALOGUE: [...catalogue.SETTING_CATALOGUE, limit] } }) as Table[];
    expect(widened.find((t) => t.table === "settings-limits")!.names).toContain("DEZFIL_STRAY_LIMIT_S");
  });

  it("cover every area once, each on its own page", () => {
    expect(SETTINGS_AREAS.map((area: { table: string }) => area.table)).toEqual(tables.filter((t) => t.table !== WIRING_TABLE.table).map((t) => t.table));
    expect(new Set(tables.map((entry) => entry.page)).size).toBe(tables.length);
  });
});

describe("the tables in the pages", () => {
  it("are each on their page, once, as the catalogue generates them", () => {
    expect(checkSettingsTables({ files, read, tables })).toEqual([]);
    for (const entry of tables) {
      const regions = tableRegions(read(entry.page)).filter((region: { name: string }) => region.name === entry.table);
      expect(regions, entry.page).toHaveLength(1);
      expect(regions[0].content).toBe(`\n${entry.markdown}\n`);
    }
  });

  const limitsPage = "docs/api/limits.md";
  const seeded = (change: (text: string) => string, page = limitsPage) => {
    const text = read(page);
    const next = change(text);
    expect(next, "the seed must change the page").not.toBe(text);
    return checkSettingsTables({ files, read: (file: string) => (file === page ? next : read(file)), tables }) as Problem[];
  };

  it("fail a stale table, naming its page and line", () => {
    const problems = seeded((text) => text.replace("| `5120` MB |", "| `4096` MB |"));
    expect(shape(problems)).toEqual([{ file: limitsPage, rule: "settings.stale" }]);
    expect(problems[0].line).toBe(read(limitsPage).split("\n").indexOf("<!-- settings-limits:start -->") + 1);
  });

  it("fail a table taken out of its page, and a page that is gone", () => {
    expect(shape(seeded((text) => text.replace(/<!-- settings-limits:start -->[\s\S]*<!-- settings-limits:end -->\n/, ""))))
      .toEqual([{ file: limitsPage, rule: "settings.missing-table" }]);
    const gone = checkSettingsTables({ files: files.filter((file) => file !== limitsPage), read, tables }) as Problem[];
    expect(shape(gone)).toEqual([{ file: limitsPage, rule: "settings.missing-page" }]);
  });

  it("fail a table on a page it does not belong to, one that is no table of the catalogue's, one twice, and one left open", () => {
    const region = /<!-- settings-limits:start -->[\s\S]*<!-- settings-limits:end -->\n/.exec(read(limitsPage))![0];
    const other = "docs/self-host/configuration.md";
    expect(shape(seeded((text) => `${text}\n${region}`, other))).toEqual([{ file: other, rule: "settings.unknown-table" }]);
    expect(shape(seeded((text) => `${text}\n<!-- settings-nowhere:start -->\n\n<!-- settings-nowhere:end -->\n`))).toEqual([{ file: limitsPage, rule: "settings.unknown-table" }]);
    expect(shape(seeded((text) => `${text}\n${region}`))).toEqual([{ file: limitsPage, rule: "settings.duplicate-table" }]);
    expect(shape(seeded((text) => text.replace("<!-- settings-limits:end -->", "")))).toEqual([
      { file: limitsPage, rule: "settings.unclosed-table" }, { file: limitsPage, rule: "settings.missing-table" },
    ]);
  });

  it("leave a marker shown in a code block alone", () => {
    expect(seeded((text) => `${text}\n\`\`\`text title="Example"\n<!-- settings-nowhere:start -->\n\`\`\`\n`)).toEqual([]);
  });

  it("are written between their markers, the rest of the page unchanged", () => {
    const pages: Record<string, string> = Object.fromEntries(tables.map((entry) => [entry.page, read(entry.page)]));
    const stale = pages[limitsPage].replace(/(<!-- settings-limits:start -->\n)[\s\S]*(<!-- settings-limits:end -->)/, "$1\nold\n$2");
    const written: Record<string, string> = {};
    const result = writeSettingsTables({ files, read: (file: string) => (file === limitsPage ? stale : pages[file]), write: (file: string, text: string) => { written[file] = text; }, tables });
    expect(result).toEqual([limitsPage]);
    expect(written[limitsPage]).toBe(pages[limitsPage]);
  });
});
