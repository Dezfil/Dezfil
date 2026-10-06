import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { open } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import * as reads from "./read";
import { PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { limits } from "@/lib/limits";
import { patchOwnSettings, readOwnSettings } from "@/lib/auth/settings";
import { activateSettingsStore, readStoredSettings, writeStoredSettings } from "./store";
import { onCommittedSettings } from "./state";
import { changeInstanceSettings } from "./change";
import { readInstanceSettings } from "./read";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); });
afterEach(() => f.close());
function patch(body: unknown) {
  return PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" }, body: JSON.stringify(body) })));
}
async function refusal(body: unknown, keys: string[], code = "invalid_request") {
  const before = readStoredSettings(f.db), response = await patch(body);
  expect(response.status).toBe(code === "setting_locked" ? 409 : 400);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const result = await response.json();
  expect(result.error.code).toBe(code);
  for (const key of keys) expect(result.error.message).toContain(key);
  expect(readStoredSettings(f.db)).toEqual(before);
  return result;
}

it.each([
  [{ unknownSetting: "secret-input" }, ["Unknown setting"]],
  [{ renderCapFeatures: 100 }, ["renderCapFeatures"]],
  [{ queryTimeoutS: "80" }, ["queryTimeoutS"]],
  [{ queryTimeoutS: 80.5 }, ["queryTimeoutS"]],
  [{ uploadMaxMb: 102401 }, ["uploadMaxMb"]],
  [{ instanceName: "x".repeat(81) }, ["instanceName"]],
  [{ signInMessage: "x".repeat(281) }, ["signInMessage"]],
  [{ lostPasswordContact: "x".repeat(121) }, ["lostPasswordContact"]],
  [{ landingPage: "elsewhere" }, ["landingPage"]],
  [{ queryTimeoutS: 600 }, ["queryTimeoutS", "operationTimeoutS"]],
  [{ operationTimeoutS: 30 }, ["queryTimeoutS", "operationTimeoutS"]],
])("refuses the entire body for %j, including its valid sibling", async (invalid, keys) => {
  await refusal({ previewRows: 200, ...invalid }, keys);
  expect(limits.previewRows).toBe(1000);
});

it.each([
  ["renderCapFeatures", "DEZFIL_RENDER_CAP_FEATURES", "50000"],
  ["port", "PORT", "3000"],
  ["extensionDir", "DUCKDB_EXTENSION_DIR", "/extensions"],
])("refuses read-only %s before its environment lock, including its valid sibling", async (key, environment, value) => {
  vi.stubEnv(environment, value);
  const result = await refusal({ previewRows: 200, [key]: 1 }, [key]);
  expect(result.error.message).toBe(`${key}: Setting is read-only.`);
  expect(limits.previewRows).toBe(1000);
});

it("collects every failing key and gives a lock precedence over validation in either order", async () => {
  writeStoredSettings({ queryTimeoutS: 80 }, f.db);
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "seed-invalid-environment");
  for (const value of [90, null, "seed-wrong-kind"]) for (const reverse of [false, true]) {
    const pairs = [["queryTimeoutS", value], ["previewRows", 1], ["landingPage", "invalid"], ["uploadMaxMb", 12]];
    const result = await refusal(Object.fromEntries(reverse ? pairs.reverse() : pairs),
      ["queryTimeoutS", "DEZFIL_QUERY_TIMEOUT_S", "previewRows", "landingPage"], "setting_locked");
    expect(JSON.stringify(result)).not.toContain("seed-invalid-environment");
    expect(JSON.stringify(result)).not.toContain("seed-wrong-kind");
  }
  expect(readInstanceSettings(f.context, f.db).settings.queryTimeoutS).toMatchObject({ storedValue: 80, value: 60, locked: true });
});

it("applies a multi-key body together, normalizes text, clears to defaults and shares the legacy writer", async () => {
  patchOwnSettings(f.context, { instanceName: "Legacy" }, f.db);
  expect(readInstanceSettings(f.context, f.db).settings.instanceName.value).toBe("Legacy");
  const response = await patch({ queryTimeoutS: 90, operationTimeoutS: 120, instanceName: "  New name  ", signInMessage: " Hello ", landingPage: "sql" });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  expect(body.settings.queryTimeoutS).toMatchObject({ value: 90, storedValue: 90, source: "stored" });
  expect(body.warnings).toEqual([]);
  expect(readStoredSettings(f.db)).toEqual({ queryTimeoutS: 90, operationTimeoutS: 120, instanceName: "New name", signInMessage: "Hello", landingPage: "sql" });
  expect(readOwnSettings(f.context, f.db).instanceName).toBe("New name");
  expect(limits.queryTimeoutMs).toBe(90_000);
  expect((await patch({ queryTimeoutS: null, operationTimeoutS: null, instanceName: null, signInMessage: null, landingPage: null })).status).toBe(200);
  expect(readStoredSettings(f.db)).toEqual({});
  expect(limits.queryTimeoutMs).toBe(60_000); expect(readOwnSettings(f.context, f.db).instanceName).toBeNull();
});

it.each(["", " \t\n "])("clears empty text %j to default values and sources", async empty => {
  writeStoredSettings({ instanceName: "Atlas", signInMessage: "Welcome", lostPasswordContact: "Ask us" }, f.db);
  const response = await patch({ instanceName: empty, signInMessage: empty, lostPasswordContact: empty });
  expect(response.status).toBe(200);
  const body = await response.json();
  for (const [key, value] of [["instanceName", null], ["signInMessage", ""], ["lostPasswordContact", ""]] as const) {
    expect(body.settings[key]).toMatchObject({ value, source: "default", storedValue: null });
  }
  expect(readStoredSettings(f.db)).toEqual({});
  expect(f.db.prepare("SELECT key FROM workspace_settings WHERE key IN ('instance_name', 'instance.signInMessage', 'instance.lostPasswordContact')").all()).toEqual([]);
});

it.each([false, true])("serializes competing timeout bodies against committed state (reverse %s)", async reverse => {
  const changes = [{ queryTimeoutS: 500 }, { operationTimeoutS: 100 }];
  const responses = await Promise.all((reverse ? changes.reverse() : changes).map(patch));
  expect(responses.map(r => r.status)).toEqual([200, 400]);
  expect(readStoredSettings(f.db)).toEqual(changes[0]);
});

it("keeps concurrent different keys and the last accepted write to one key", async () => {
  expect((await Promise.all([patch({ previewRows: 200 }), patch({ uploadMaxMb: 12 })])).map(r => r.status)).toEqual([200, 200]);
  expect(readStoredSettings(f.db)).toEqual({ previewRows: 200, uploadMaxMb: 12 });
  expect((await Promise.all([patch({ previewRows: 300 }), patch({ previewRows: 400 })])).map(r => r.status)).toEqual([200, 200]);
  expect(readStoredSettings(f.db)).toEqual({ previewRows: 400, uploadMaxMb: 12 });
});

it("reports an environment timeout mismatch without blocking unrelated changes", async () => {
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "600"); vi.stubEnv("DEZFIL_OPERATION_TIMEOUT_S", "100");
  const response = await patch({ previewRows: 200 });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.warnings).toEqual([expect.stringMatching(/queryTimeoutS.*operationTimeoutS/)]);
  expect(readInstanceSettings(f.context, f.db).warnings).toEqual(body.warnings);
  expect(body.settings.queryTimeoutS).toMatchObject({ value: 600, locked: true });
  expect(body.settings.operationTimeoutS).toMatchObject({ value: 100, locked: true });
  expect(readStoredSettings(f.db)).toEqual({ previewRows: 200 });
});

it("checks null against the resulting pair and validates against storage inside an outer transaction", async () => {
  changeInstanceSettings(f.context, { queryTimeoutS: 10, operationTimeoutS: 30 }, f.db);
  await refusal({ queryTimeoutS: null, previewRows: 200 }, ["queryTimeoutS", "operationTimeoutS"]);
  f.db.transaction(() => {
    changeInstanceSettings(f.context, { operationTimeoutS: 100 }, f.db);
    expect(limits.operationTimeoutMs).toBe(30_000);
    expect(() => changeInstanceSettings(f.context, { queryTimeoutS: 100 }, f.db)).toThrow(/queryTimeoutS.*operationTimeoutS/);
  })();
  expect(limits.operationTimeoutMs).toBe(100_000);
});

it.each(["write", "after-write", "response", "commit"])("rolls back %s failure without publishing or waking consumers", async failure => {
  const notify = vi.fn(), unsubscribe = onCommittedSettings("change-test", notify);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    if (failure === "write") f.db.exec("CREATE TRIGGER reject_setting BEFORE INSERT ON workspace_settings WHEN NEW.key = 'instance.uploadMaxMb' BEGIN SELECT RAISE(ABORT, 'seed-storage-secret'); END");
    if (failure === "commit") f.db.exec("CREATE TABLE deferred_child (parent TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON workspace_settings BEGIN INSERT INTO deferred_child VALUES ('missing'); END");
    if (failure === "response") vi.spyOn(reads, "readInstanceSettings").mockImplementation(() => { throw new Error("seed-response-secret"); });
    if (failure === "after-write") {
      expect(() => f.db.transaction(() => { changeInstanceSettings(f.context, { queryTimeoutS: 80, uploadMaxMb: 12 }, f.db); throw new Error("stop"); })()).toThrow("stop");
    } else {
      const response = await patch({ queryTimeoutS: 80, uploadMaxMb: 12 });
      expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: "internal", message: "An unexpected server error occurred." } });
    }
    expect(readStoredSettings(f.db)).toEqual({}); expect(limits.queryTimeoutMs).toBe(60_000);
    expect(notify).not.toHaveBeenCalled();
  } finally { unsubscribe(); log.mockRestore(); }
});

it("preserves the complete accepted patch across closing and reopening the file store", () => {
  const file = path.join(f.dir, "persistent.sqlite"), db = open(file);
  let reopened: ReturnType<typeof open> | undefined;
  try {
    testAccountScope(db, "admin"); db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
    const session = issueSession(getAccount("admin", db)!, db, Date.now());
    const context = authenticateSession(session.secret, db)!;
    changeInstanceSettings(context, { queryTimeoutS: 80, operationTimeoutS: 100, instanceName: "Persistent", lostPasswordContact: "Contact us" }, db);
    db.close(); reopened = open(file);
    const response = readInstanceSettings(context, reopened);
    expect(response.settings.queryTimeoutS).toMatchObject({ value: 80, source: "stored" });
    expect(response.settings.operationTimeoutS).toMatchObject({ value: 100, source: "stored" });
    expect(response.settings.instanceName.value).toBe("Persistent"); expect(response.settings.lostPasswordContact.value).toBe("Contact us");
  } finally { if (db.open) db.close(); reopened?.close(); }
});

it("publishes the operation to already-loaded consumers only at the durable outer boundary", async () => {
  const events: number[] = [], unsubscribe = onCommittedSettings("change-test", () => events.push(limits.queryTimeoutMs));
  vi.resetModules();
  const other = await import("@/lib/limits");
  try {
    f.db.transaction(() => {
      changeInstanceSettings(f.context, { queryTimeoutS: 80 }, f.db);
      expect([limits.queryTimeoutMs, other.limits.queryTimeoutMs]).toEqual([60_000, 60_000]);
      expect(events).toEqual([]);
    })();
    expect([limits.queryTimeoutMs, other.limits.queryTimeoutMs]).toEqual([80_000, 80_000]);
    expect(events).toEqual([80_000]);
  } finally { unsubscribe(); }
});

it.each([["null", "application/json", 400], ["[]", "application/json", 400], ["{broken", "application/json", 400],
  ['{"previewRows":200}', "text/plain", 400], [" ".repeat(65537), "application/json", 413]])(
  "refuses malformed or oversized input without effects (case %#)", async (body, contentType, status) => {
    const response = await PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { authorization: `Bearer ${f.token.secret}`, "content-type": contentType as string }, body: body as string })));
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: { code: status === 413 ? "request_body_too_large" : "invalid_request" } });
    expect(readStoredSettings(f.db)).toEqual({});
  });
