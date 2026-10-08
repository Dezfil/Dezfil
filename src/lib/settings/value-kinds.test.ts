import { mkdtempSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { INSTANCE_SETTINGS_SCHEMAS } from "@/lib/api/openapi-instance-settings";
import { activateSettingsStore, readStoredSettings, writeStoredSettings } from "./store";
import { committedNumericSettings, onCommittedSettings } from "./state";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/** The catalogue as shipped, plus one stored instance setting of each newer
 * value kind, so the foundation is held for the kinds before any shipped
 * setting uses them. */
vi.mock("./catalogue", async importOriginal => {
  const actual = await importOriginal<typeof import("./catalogue")>();
  const base = actual.settingDefinition("landingPage");
  const seeded = [
    { ...base, key: "seeded.zoom", label: "Seeded zoom", purpose: "A number kept as given.", kind: "number" as const,
      defaultValue: 1.3, documentedDefault: "1.3", write: { kind: "decimal" as const, min: 0, max: 22 } },
    { ...base, key: "seeded.wrap", label: "Seeded wrap", purpose: "On or off.", kind: "boolean" as const,
      defaultValue: false, documentedDefault: "off", write: { kind: "switch" as const } },
  ];
  const catalogue = [...actual.SETTING_CATALOGUE, ...seeded];
  const byKey = new Map(catalogue.map(definition => [definition.key, definition]));
  return { ...actual, SETTING_CATALOGUE: catalogue, settingDefinition(key: string) {
    const definition = byKey.get(key);
    if (!definition) throw new Error(`Unknown setting: ${key}`);
    return definition;
  } };
});

let f: ReturnType<typeof instanceSettingsFixture>;
const opened: Database[] = [];
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); f.close(); });
function fileStore(file: string) { const db = open(file); opened.push(db); return db; }
const storedRows = (db: Database) => db.prepare("SELECT key, value FROM workspace_settings WHERE key LIKE 'instance.seeded.%' ORDER BY key").all();

describe("the store", () => {
  it("keeps a decimal exactly and reads a switch back from its text, through a reopened store", () => {
    const file = path.join(mkdtempSync(path.join(f.dir, "kinds-")), "metadata.sqlite");
    const first = fileStore(file);
    writeStoredSettings({ "seeded.zoom": 0.1 + 0.2, "seeded.wrap": true }, first);
    expect(storedRows(first)).toEqual([{ key: "instance.seeded.wrap", value: "true" }, { key: "instance.seeded.zoom", value: "0.30000000000000004" }]);
    first.close();
    const second = fileStore(file);
    expect(readStoredSettings(second)).toEqual({ "seeded.zoom": 0.30000000000000004, "seeded.wrap": true });
    writeStoredSettings({ "seeded.zoom": 21.75, "seeded.wrap": false }, second);
    second.close();
    const third = fileStore(file);
    expect(readStoredSettings(third)).toEqual({ "seeded.zoom": 21.75, "seeded.wrap": false });
    writeStoredSettings({ "seeded.zoom": null, "seeded.wrap": null }, third);
    expect(storedRows(third)).toEqual([]);
    expect(readStoredSettings(third)).toEqual({});
  });

  it("reads a stored switch that is neither true nor false as unset", () => {
    f.db.prepare("INSERT INTO workspace_settings (key, value, updated_at) VALUES ('instance.seeded.wrap', 'yes', '2026-01-01T00:00:00.000Z')").run();
    expect(readStoredSettings(f.db)).toEqual({});
  });

  it("keeps a stored decimal out of the numeric limits' snapshot and never wakes their listeners", () => {
    const file = path.join(mkdtempSync(path.join(f.dir, "snapshot-")), "metadata.sqlite");
    const first = fileStore(file);
    writeStoredSettings({ "seeded.zoom": 4.5, "seeded.wrap": true }, first);
    first.close();
    // A store opened with a decimal already stored activates without it.
    const store = fileStore(file); activateSettingsStore(store);
    expect(committedNumericSettings()).toEqual({});
    const notify = vi.fn(), unsubscribe = onCommittedSettings("value-kinds-test", notify);
    try {
      writeStoredSettings({ "seeded.zoom": 7.25 }, store);
      writeStoredSettings({ "seeded.wrap": false }, store);
      expect(committedNumericSettings()).toEqual({});
      expect(notify).not.toHaveBeenCalled();
      // A numeric limit still enters it and wakes them.
      writeStoredSettings({ queryTimeoutS: 80 }, store);
      expect(committedNumericSettings()).toEqual({ queryTimeoutS: 80 });
      expect(notify).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
});

describe("the change operation", () => {
  beforeEach(() => activateSettingsStore(f.db));
  const patch = (body: unknown) => PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body) })));

  it("keeps an in-range decimal as given and a switch, reports them stored and clears them to the default", async () => {
    const response = await patch({ "seeded.zoom": 0.1 + 0.2, "seeded.wrap": false });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings["seeded.zoom"]).toMatchObject({ value: 0.30000000000000004, storedValue: 0.30000000000000004, source: "stored", locked: false });
    expect(body.settings["seeded.wrap"]).toMatchObject({ value: false, storedValue: false, source: "stored", locked: false });
    expect(readStoredSettings(f.db)).toEqual({ "seeded.zoom": 0.30000000000000004, "seeded.wrap": false });
    const cleared = await (await patch({ "seeded.zoom": null, "seeded.wrap": null })).json();
    expect(cleared.settings["seeded.zoom"]).toMatchObject({ value: 1.3, storedValue: null, source: "default" });
    expect(cleared.settings["seeded.wrap"]).toMatchObject({ value: false, storedValue: null, source: "default" });
    expect(readStoredSettings(f.db)).toEqual({});
  });

  it.each([
    ["a decimal above its bounds", '{"previewRows":200,"seeded.wrap":true,"seeded.zoom":22.5}', "seeded.zoom: Expected a number from 0 to 22."],
    ["a decimal below its bounds", '{"previewRows":200,"seeded.wrap":true,"seeded.zoom":-0.5}', "seeded.zoom: Expected a number from 0 to 22."],
    ["a decimal that is not finite", '{"previewRows":200,"seeded.wrap":true,"seeded.zoom":1e999}', "seeded.zoom: Expected a number from 0 to 22."],
    ["a decimal written as text", '{"previewRows":200,"seeded.wrap":true,"seeded.zoom":"1.5"}', "seeded.zoom: Expected a number from 0 to 22."],
    ["a switch written as text", '{"previewRows":200,"seeded.zoom":2.5,"seeded.wrap":"true"}', "seeded.wrap: Expected true or false."],
    ["a switch written as a number", '{"previewRows":200,"seeded.zoom":2.5,"seeded.wrap":1}', "seeded.wrap: Expected true or false."],
  ])("refuses %s, naming key and reason, and stores nothing of the body", async (_name, body, message) => {
    const before = readStoredSettings(f.db);
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message } });
    expect(readStoredSettings(f.db)).toEqual(before);
    expect(storedRows(f.db)).toEqual([]);
  });
});

it("describes each kind in the change operation's input", () => {
  const properties = INSTANCE_SETTINGS_SCHEMAS.InstanceSettingsPatch.properties as Record<string, Record<string, unknown>>;
  expect(properties["seeded.zoom"]).toEqual({ type: ["number", "null"], minimum: 0, maximum: 22,
    description: "Seeded zoom. A number kept as given. Null clears the stored value." });
  expect(properties["seeded.wrap"]).toEqual({ type: ["boolean", "null"],
    description: "Seeded wrap. On or off. Null clears the stored value." });
});
