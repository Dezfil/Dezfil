import { mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb, open } from "@/lib/metadata/db";
import { instanceName, setInstanceName } from "@/lib/metadata/settings";
import { limits } from "@/lib/limits";
import { resolveNumericSetting } from "./resolver";
import { activateSettingsStore, readStoredSettings, writeStoredSettings } from "./store";
import { onCommittedSettings } from "./state";
import { createFirstAccount } from "@/lib/auth/accounts";
import { authenticateSession } from "@/lib/auth/credentials";
import { patchOwnSettings, readOwnSettings } from "@/lib/auth/settings";

let db: Database;
const opened: Database[] = [];
beforeEach(() => {
  for (const name of ["DEZFIL_QUERY_TIMEOUT_S", "DEZFIL_UPLOAD_MAX_MB", "DEZFIL_OPERATION_TIMEOUT_S"]) vi.stubEnv(name, "");
  db = open(":memory:"); opened.push(db); activateSettingsStore(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of opened.splice(0)) if (connection.open) connection.close();
  closeMetadataDb(); vi.unstubAllEnvs();
});
function fileStore(file: string) { const connection = open(file); opened.push(connection); return connection; }

it("keeps defaults without opening a store from a pure consumer", () => {
  db.close();
  const before = readdirSync(process.env.DEZFIL_DATA_DIR!);
  expect(limits.queryTimeoutMs).toBe(60_000);
  expect(limits.uploadMaxBytes).toBe(5120 * 1024 ** 2);
  expect(readdirSync(process.env.DEZFIL_DATA_DIR!)).toEqual(before);
});

it("publishes a whole write only after the caller's outer durable commit", () => {
  const events: number[] = [], unsubscribe = onCommittedSettings("store-test", () => events.push(limits.queryTimeoutMs));
  try {
    db.transaction(() => {
      writeStoredSettings({ queryTimeoutS: 80, uploadMaxMb: 12 }, db);
      expect(readStoredSettings(db)).toMatchObject({ queryTimeoutS: 80, uploadMaxMb: 12 });
      expect(limits.queryTimeoutMs).toBe(60_000);
      expect(limits.uploadMaxBytes).toBe(5120 * 1024 ** 2);
      expect(events).toEqual([]);
    }).immediate();
    expect([limits.queryTimeoutMs, limits.uploadMaxBytes]).toEqual([80_000, 12 * 1024 ** 2]);
    expect(events).toEqual([80_000]);
  } finally { unsubscribe(); }
});

it("leaves storage, consumers and notifications unchanged on outer rollback or failed commit", () => {
  const notify = vi.fn(), unsubscribe = onCommittedSettings("store-test", notify);
  db.exec("CREATE TABLE deferred_child (parent TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED)");
  try {
    for (const failure of ["rollback", "commit"]) {
      expect(() => db.transaction(() => {
        writeStoredSettings({ queryTimeoutS: 80, instanceName: "Uncommitted" }, db);
        if (failure === "rollback") throw new Error("injected rollback");
        db.prepare("INSERT INTO deferred_child VALUES ('missing')").run();
      })()).toThrow();
      expect(readStoredSettings(db)).toEqual({});
      expect(instanceName(db)).toBeNull(); expect(limits.queryTimeoutMs).toBe(60_000);
      expect(notify).not.toHaveBeenCalled();
    }
  } finally { unsubscribe(); }
});

it("publishes only surviving changes when a nested savepoint rolls back", () => {
  db.transaction(() => {
    writeStoredSettings({ queryTimeoutS: 80 }, db);
    expect(() => db.transaction(() => {
      writeStoredSettings({ queryTimeoutS: 90, uploadMaxMb: 12 }, db);
      throw new Error("discard inner");
    })()).toThrow("discard inner");
    expect(limits.queryTimeoutMs).toBe(60_000);
  })();
  expect(readStoredSettings(db)).toEqual({ queryTimeoutS: 80 });
  expect(limits.queryTimeoutMs).toBe(80_000);
});

it("observes explicit transaction completion as well as transaction callbacks", () => {
  db.exec("BEGIN IMMEDIATE"); writeStoredSettings({ queryTimeoutS: 80 }, db);
  expect(limits.queryTimeoutMs).toBe(60_000);
  db.exec("COMMIT"); expect(limits.queryTimeoutMs).toBe(80_000);
  db.exec("BEGIN"); writeStoredSettings({ queryTimeoutS: 90 }, db);
  db.exec("ROLLBACK"); expect(limits.queryTimeoutMs).toBe(80_000);
  db.prepare("BEGIN").run(); writeStoredSettings({ queryTimeoutS: 100 }, db);
  expect(limits.queryTimeoutMs).toBe(80_000);
  db.prepare("COMMIT").run(); expect(limits.queryTimeoutMs).toBe(100_000);
});

it("resolves committed values without store I/O", () => {
  writeStoredSettings({ queryTimeoutS: 80 }, db);
  const prepare = vi.spyOn(db, "prepare");
  for (let i = 0; i < 100; i++) expect(limits.queryTimeoutMs).toBe(80_000);
  expect(prepare).not.toHaveBeenCalled();
});

it("never publishes a partial multi-key write when storage rejects a row", () => {
  db.exec("CREATE TRIGGER reject_setting BEFORE INSERT ON workspace_settings WHEN NEW.key = 'instance.uploadMaxMb' BEGIN SELECT RAISE(ABORT, 'injected write'); END");
  expect(() => writeStoredSettings({ queryTimeoutS: 80, uploadMaxMb: 12 }, db)).toThrow("injected write");
  expect(readStoredSettings(db)).toEqual({}); expect(limits.queryTimeoutMs).toBe(60_000);
});

it.each(["2.9", "invalid-override-seed"])("keeps the environment locked across stored writes for %s", raw => {
  writeStoredSettings({ queryTimeoutS: 80 }, db);
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", raw);
  expect(resolveNumericSetting("queryTimeoutS")).toMatchObject({
    value: raw === "2.9" ? 2.9 : 60, locked: true, storedValue: 80, invalidOverride: raw !== "2.9",
  });
  for (const value of [90, null]) {
    expect(() => writeStoredSettings({ uploadMaxMb: 12, queryTimeoutS: value }, db)).toThrow("DEZFIL_QUERY_TIMEOUT_S");
    expect(readStoredSettings(db)).toEqual({ queryTimeoutS: 80 });
  }
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "");
  expect(limits.queryTimeoutMs).toBe(80_000);
  writeStoredSettings({ queryTimeoutS: null }, db);
  expect(limits.queryTimeoutMs).toBe(60_000); expect(readStoredSettings(db)).toEqual({});
});

it("uses the same instance-name row in both writer directions, including clear and rollback", () => {
  setInstanceName("Legacy writer", db);
  expect(readStoredSettings(db)).toEqual({ instanceName: "Legacy writer" });
  writeStoredSettings({ instanceName: "  New writer  ", signInMessage: " Hello " }, db);
  expect(instanceName(db)).toBe("New writer");
  expect(readStoredSettings(db)).toMatchObject({ instanceName: "New writer", signInMessage: "Hello" });
  expect(() => db.transaction(() => {
    setInstanceName("Rolled back", db); writeStoredSettings({ signInMessage: "Rolled back" }, db);
    throw new Error("rollback");
  })()).toThrow();
  expect(instanceName(db)).toBe("New writer");
  writeStoredSettings({ instanceName: null }, db); expect(instanceName(db)).toBeNull();
  setInstanceName("Again", db); setInstanceName(null, db);
  expect(readStoredSettings(db)).toEqual({ signInMessage: "Hello" });
});

it.each([
  ["renderCapFeatures", "DEZFIL_RENDER_CAP_FEATURES", "50000"],
  ["port", "PORT", "3000"],
  ["extensionDir", "DUCKDB_EXTENSION_DIR", "/extensions"],
])("refuses read-only %s before its environment lock at the repository boundary", (key, environment, value) => {
  vi.stubEnv(environment, value);
  expect(() => writeStoredSettings({ uploadMaxMb: 12, [key]: 1 }, db)).toThrow(`${key}: Setting is read-only.`);
  expect(readStoredSettings(db)).toEqual({});
  expect(limits.uploadMaxBytes).toBe(5120 * 1024 ** 2);
});

it("updates two already-loaded consumers and writer bundles through the same file identity", async () => {
  db.close();
  const file = path.join(mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "settings-")), "metadata.sqlite");
  const first = fileStore(file); activateSettingsStore(first);
  const oldLimits = limits;
  vi.resetModules();
  const fresh = await import("@/lib/limits");
  const otherStoreModule = await import("./store");
  const otherDbModule = await import("@/lib/metadata/db");
  const second = otherDbModule.open(file); opened.push(second);
  otherStoreModule.writeStoredSettings({ queryTimeoutS: 80, uploadMaxMb: 12 }, second);
  expect([oldLimits.queryTimeoutMs, fresh.limits.queryTimeoutMs]).toEqual([80_000, 80_000]);
  expect([oldLimits.uploadMaxBytes, fresh.limits.uploadMaxBytes]).toEqual([12 * 1024 ** 2, 12 * 1024 ** 2]);
  setInstanceName("First connection", first);
  expect(otherStoreModule.readStoredSettings(second).instanceName).toBe("First connection");
  otherStoreModule.writeStoredSettings({ instanceName: "Second connection" }, second);
  expect(instanceName(first)).toBe("Second connection");
});

it("keeps the existing own-settings operation coherent with the instance repository writer", async () => {
  const account = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "river otter telescope" }, db);
  const actor = authenticateSession(account.secret, db)!;
  patchOwnSettings(actor, { instanceName: "Own settings" }, db);
  expect(readStoredSettings(db).instanceName).toBe("Own settings");
  writeStoredSettings({ instanceName: "Instance settings" }, db);
  expect(readOwnSettings(actor, db).instanceName).toBe("Instance settings");
  expect(() => db.transaction(() => {
    patchOwnSettings(actor, { instanceName: "Uncommitted" }, db);
    writeStoredSettings({ instanceName: "Also uncommitted", queryTimeoutS: 80 }, db);
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect(readOwnSettings(actor, db).instanceName).toBe("Instance settings");
  expect(limits.queryTimeoutMs).toBe(60_000);
});

it("isolates unrelated file and memory stores, clears on close and reloads persisted values", () => {
  db.close();
  const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "lifecycle-"));
  const file = path.join(dir, "active.sqlite"), first = fileStore(file); activateSettingsStore(first);
  writeStoredSettings({ queryTimeoutS: 80, uploadMaxMb: 12 }, first);
  for (const unrelated of [fileStore(path.join(dir, "other.sqlite")), fileStore(":memory:")]) {
    writeStoredSettings({ queryTimeoutS: 90 }, unrelated);
    expect(limits.queryTimeoutMs).toBe(80_000);
    unrelated.close(); expect(limits.queryTimeoutMs).toBe(80_000);
  }
  first.close(); expect(limits.queryTimeoutMs).toBe(60_000);
  const reopened = fileStore(file); activateSettingsStore(reopened);
  expect([limits.queryTimeoutMs, limits.uploadMaxBytes]).toEqual([80_000, 12 * 1024 ** 2]);
  reopened.close(); const memory = fileStore(":memory:"); activateSettingsStore(memory);
  expect(readStoredSettings(memory)).toEqual({}); expect(limits.queryTimeoutMs).toBe(60_000);
});

it("loads and resets the singleton without letting an explicit open replace it", () => {
  db.close();
  const root = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "singleton-"));
  vi.stubEnv("DEZFIL_DATA_DIR", root);
  const singleton = metadataDb(); writeStoredSettings({ queryTimeoutS: 80 }, singleton);
  fileStore(":memory:"); expect(limits.queryTimeoutMs).toBe(80_000);
  closeMetadataDb(); expect(limits.queryTimeoutMs).toBe(60_000);
  metadataDb(); expect(limits.queryTimeoutMs).toBe(80_000);
  closeMetadataDb();
  vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "fresh-")));
  metadataDb(); expect(limits.queryTimeoutMs).toBe(60_000);
});

it("resets every loaded singleton bundle before selecting a fresh data directory", async () => {
  db.close();
  const root = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "bundle-reset-"));
  vi.stubEnv("DEZFIL_DATA_DIR", root);
  writeStoredSettings({ queryTimeoutS: 80 }, metadataDb());
  vi.resetModules();
  const other = await import("@/lib/metadata/db");
  const otherHandle = other.metadataDb();
  try {
    expect(limits.queryTimeoutMs).toBe(80_000);
    closeMetadataDb();
    expect(limits.queryTimeoutMs).toBe(60_000);
    expect(otherHandle.open).toBe(false);
    vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "fresh-")));
    expect(readStoredSettings(other.metadataDb())).toEqual({});
    expect(other.metadataDb()).toBe(metadataDb());
    expect(limits.queryTimeoutMs).toBe(60_000);
    writeStoredSettings({ queryTimeoutS: 90 }, other.metadataDb());
    expect(limits.queryTimeoutMs).toBe(90_000);
    other.closeMetadataDb(); expect(limits.queryTimeoutMs).toBe(60_000);
  } finally { other.closeMetadataDb(); }
});
