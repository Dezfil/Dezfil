import { mkdtempSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { SETTING_CATALOGUE, settingDefinition } from "./catalogue";
import { readInstanceSettings } from "./read";
import { readStoredSettings, writeStoredSettings } from "./store";
import { catalogueProblems, validateStoredValue } from "./validation";
import type { SettingDefinition } from "./types";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The sites kind: the sites that may show published pages in a frame, each
 * http or https with a host and an optional port and nothing else, at most
 * fifty, stored as lines and read back as a list.
 */
const KEY = "publishing.embedSites";
const sites = () => settingDefinition(KEY);
const entryRefused = (position: number) => ({ ok: false,
  reason: `Expected each site as http or https with a host and an optional port, nothing else; entry ${position} is not.` });
const listRefused = { ok: false, reason: "Expected a list of at most 50 sites." };

let f: ReturnType<typeof instanceSettingsFixture>;
const opened: Database[] = [];
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); f.close(); });
function fileStore(file: string) { const db = open(file); opened.push(db); return db; }
const storedRow = (db: Database) => db.prepare("SELECT value FROM workspace_settings WHERE key = ?").all(`instance.${KEY}`);

describe("a list of sites", () => {
  it("keeps http and https sites with a host and an optional port, each as its scheme, host and port", () => {
    expect(validateStoredValue(sites(), ["https://portal.example", "http://intranet.example:8080", "https://10.0.0.5:8443", "https://localhost"]))
      .toEqual({ ok: true, value: ["https://portal.example", "http://intranet.example:8080", "https://10.0.0.5:8443", "https://localhost"] });
    // Case, a bare closing slash, the scheme's own port and surrounding space name the same site.
    expect(validateStoredValue(sites(), ["  HTTPS://Maps.Example/ ", "https://maps.example:443", "http://intranet.example:80"]))
      .toEqual({ ok: true, value: ["https://maps.example", "http://intranet.example"] });
  });

  it.each([
    ["a path", "https://portal.example/embed"],
    ["a query", "https://portal.example/?map=1"],
    ["an empty query", "https://portal.example?"],
    ["a fragment", "https://portal.example#top"],
    ["user information", "https://seed-user:seed-password@portal.example"],
    ["another scheme", "ftp://portal.example"],
    ["a script address", "javascript:alert(1)"],
    ["no scheme", "portal.example"],
    ["a wildcard host", "https://*.portal.example"],
    ["a host with a separator", "https://portal.example;frame-ancestors"],
    ["an empty label", "https://portal..example"],
    ["a bracketed address", "https://[::1]:8443"],
    ["a port out of range", "https://portal.example:99999"],
    ["a backslash", "https:\\\\portal.example"],
    ["a line break inside", "https://portal.example\nhttps://other.example"],
    ["an empty entry", ""],
    ["a blank entry", "   "],
  ])("refuses %s, naming its entry and echoing nothing", (_name, entry) => {
    const result = validateStoredValue(sites(), ["https://kept.example", entry]);
    expect(result).toEqual(entryRefused(2));
    if (entry.trim()) expect(JSON.stringify(result)).not.toContain(entry.trim());
  });

  it("keeps fifty sites and refuses a fifty-first", () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `https://site-${index + 1}.example`);
    expect(validateStoredValue(sites(), fifty)).toEqual({ ok: true, value: fifty });
    expect(validateStoredValue(sites(), [...fifty, "https://site-51.example"])).toEqual(listRefused);
  });

  it.each([
    ["one site as text", "https://portal.example"],
    ["a number", 1],
    ["true", true],
    ["an object", { site: "https://portal.example" }],
    ["a list holding a number", [1]],
    ["a list holding null", [null]],
  ])("refuses %s", (_name, input) => {
    expect(validateStoredValue(sites(), input).ok).toBe(false);
  });

  it("clears with an empty list or null, and keeps one of each repeated site", () => {
    expect(validateStoredValue(sites(), [])).toEqual({ ok: true, value: null });
    expect(validateStoredValue(sites(), null)).toEqual({ ok: true, value: null });
    expect(validateStoredValue(sites(), ["https://portal.example", "https://Portal.example/", "http://portal.example"]))
      .toEqual({ ok: true, value: ["https://portal.example", "http://portal.example"] });
  });
});

describe("the sites kind in the store and the read", () => {
  it("stores the list as lines and reads it back as a list, through a reopened store, and clears it", () => {
    const file = path.join(mkdtempSync(path.join(f.dir, "sites-")), "metadata.sqlite");
    const first = fileStore(file);
    writeStoredSettings({ [KEY]: ["https://portal.example", "http://intranet.example:8080"] }, first);
    expect(storedRow(first)).toEqual([{ value: "https://portal.example\nhttp://intranet.example:8080" }]);
    first.close();
    const second = fileStore(file);
    expect(readStoredSettings(second)).toEqual({ [KEY]: ["https://portal.example", "http://intranet.example:8080"] });
    writeStoredSettings({ [KEY]: [] }, second);
    expect(storedRow(second)).toEqual([]);
    expect(readStoredSettings(second)).toEqual({});
  });

  it("reads a stored line that is not a site as unset", () => {
    f.db.prepare("INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')")
      .run(`instance.${KEY}`, "https://portal.example\nftp://elsewhere.example");
    expect(readStoredSettings(f.db)).toEqual({});
  });

  it("reports the list to an admin as a list: empty by default, as stored once stored", () => {
    expect(readInstanceSettings(f.context, f.db).settings[KEY]).toMatchObject({
      kind: "list", write: { kind: "sites", maxSites: 50 }, defaultValue: [], documentedDefault: "none",
      value: [], source: "default", storedValue: null, locked: false,
    });
    writeStoredSettings({ [KEY]: ["https://portal.example"] }, f.db);
    expect(readInstanceSettings(f.context, f.db).settings[KEY]).toMatchObject({
      value: ["https://portal.example"], source: "stored", storedValue: ["https://portal.example"],
    });
  });
});

describe("the sites kind in the catalogue check", () => {
  /** A sites row of its own, so only the seeded part differs. */
  const seeded = (): SettingDefinition => ({ ...sites(), key: "seeded.sites", label: "Seeded sites" });

  it("admits a well-formed sites definition", () => {
    expect(catalogueProblems([...SETTING_CATALOGUE, seeded()])).toEqual([]);
  });

  it.each([
    ["a sites constraint on a text definition", { kind: "text" }, "invalid sites constraint"],
    ["a sites constraint with no room for a site", { write: { kind: "sites", maxSites: 0 } }, "invalid sites constraint"],
    ["a sites constraint with an unbounded count", { write: { kind: "sites", maxSites: Infinity } }, "invalid sites constraint"],
    ["a default that is not a list of sites", { defaultValue: ["ftp://portal.example"] }, "default fails validation"],
  ] as [string, Partial<SettingDefinition>, string][])("fails the catalogue with %s", (_name, change, problem) => {
    expect(catalogueProblems([...SETTING_CATALOGUE, { ...seeded(), ...change } as SettingDefinition])).toContain(`seeded.sites: ${problem}`);
  });
});
