import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { assistantKeyFacts, cleanKey, isCurrentSave, readAssistantKey, removeAssistantKey, saveAssistantKey } from "./store";

const CANARY = "sk-canary-0123456789abcdef-f00d";
let db: Database, dir: string, file: string;
function allFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => { const at = path.join(root, name); return statSync(at).isDirectory() ? allFiles(at) : [at]; });
}
beforeEach(() => {
  dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "assistant-keys-"));
  file = path.join(dir, "metadata.sqlite");
  db = open(file);
  for (const id of ["ada", "lin"]) insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: null, isAdmin: false, status: "active", now: "time" }, db);
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); resetSecretKeyCache(); });

it("keeps a key encrypted, shown only as its last four and the time it was saved", () => {
  const saved = saveAssistantKey("ada", "anthropic", CANARY, db, Date.parse("2026-10-31T10:00:00Z"));
  expect(saved).toEqual({ replaced: false, facts: { provider: "anthropic", lastFour: "f00d", savedAt: "2026-10-31T10:00:00.000Z" } });
  expect(assistantKeyFacts("ada", db)).toEqual(saved.facts);
  expect(assistantKeyFacts("lin", db)).toBeNull();
  const stored = db.prepare("SELECT key_encrypted FROM assistant_keys WHERE account_id = 'ada'").get() as { key_encrypted: string };
  expect(stored.key_encrypted).not.toContain(CANARY);
  expect(stored.key_encrypted.split(":")).toHaveLength(3);
  expect(readAssistantKey("ada", db)).toEqual({ ...saved.facts, key: CANARY, save: stored.key_encrypted });
  db.pragma("wal_checkpoint(TRUNCATE)");
  for (const at of allFiles(dir)) expect(readFileSync(at).includes(Buffer.from(CANARY)), at).toBe(false);
});

it("holds one key per account: a replacement takes its place, another account's stays", () => {
  saveAssistantKey("ada", "anthropic", CANARY, db);
  saveAssistantKey("lin", "openai", "sk-the-other-persons-key-0000", db);
  const first = readAssistantKey("ada", db) as { save: string };
  expect(saveAssistantKey("ada", "openai", "sk-replacement-key-000000-beef", db).replaced).toBe(true);
  expect(db.prepare("SELECT count(*) AS count FROM assistant_keys WHERE account_id = 'ada'").get()).toEqual({ count: 1 });
  expect(readAssistantKey("ada", db)).toMatchObject({ provider: "openai", key: "sk-replacement-key-000000-beef", lastFour: "beef" });
  expect(isCurrentSave("ada", first.save, db)).toBe(false);
  expect(readAssistantKey("lin", db)).toMatchObject({ key: "sk-the-other-persons-key-0000" });
});

it("removes a key, and removing twice is harmless", () => {
  saveAssistantKey("ada", "anthropic", CANARY, db);
  const { save } = readAssistantKey("ada", db) as { save: string };
  expect(isCurrentSave("ada", save, db)).toBe(true);
  expect(removeAssistantKey("ada", db)).toBe(true);
  expect(removeAssistantKey("ada", db)).toBe(false);
  expect(readAssistantKey("ada", db)).toBeNull();
  expect(isCurrentSave("ada", save, db)).toBe(false);
});

it("reads a key it can no longer open as unreadable, keeping its facts until replaced", () => {
  saveAssistantKey("ada", "anthropic", CANARY, db);
  db.prepare("UPDATE assistant_keys SET key_encrypted = ? WHERE account_id = 'ada'").run("AAAA:BBBB:CCCC");
  expect(readAssistantKey("ada", db)).toBe("unreadable");
  expect(assistantKeyFacts("ada", db)).toMatchObject({ lastFour: "f00d" });
  expect(saveAssistantKey("ada", "anthropic", CANARY, db).replaced).toBe(true);
  expect(readAssistantKey("ada", db)).toMatchObject({ key: CANARY });
});

it.each([
  ["a number", 1234567890123456], ["nothing", undefined], ["fifteen characters", "x".repeat(15)], ["513 characters", "x".repeat(513)],
  ["a space inside", `${"x".repeat(10)} ${"x".repeat(10)}`], ["a tab inside", `${"x".repeat(10)}\t${"x".repeat(10)}`],
  ["a newline inside", `${"x".repeat(10)}\n${"x".repeat(10)}`], ["a control character inside", `${"x".repeat(10)}\u0007${"x".repeat(10)}`],
])("refuses %s as a key", (_label, value) => { expect(cleanKey(value)).toBeNull(); });
it("takes a key trimmed, from 16 to 512 characters", () => {
  expect(cleanKey(`  ${"x".repeat(16)}\n`)).toBe("x".repeat(16));
  expect(cleanKey("x".repeat(512))).toBe("x".repeat(512));
});

it("keeps keys across a restart and a copy of the store with its encryption key", () => {
  saveAssistantKey("ada", "anthropic", CANARY, db, 1000);
  db.close(); db = open(file);
  expect(readAssistantKey("ada", db)).toMatchObject({ key: CANARY, provider: "anthropic" });
  db.close();
  cpSync(file, path.join(dir, "restored.sqlite"));
  db = open(path.join(dir, "restored.sqlite"));
  resetSecretKeyCache();
  expect(readAssistantKey("ada", db)).toMatchObject({ key: CANARY, lastFour: "f00d", savedAt: new Date(1000).toISOString() });
});
