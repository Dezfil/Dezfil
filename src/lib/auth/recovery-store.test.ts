import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open, MIGRATIONS } from "@/lib/metadata/db";
import { insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { openRecoveryStore, validateRecoveryStore, recoveryOrigin, selectRecoveryAdmin,
  RECOVERY_SCHEMA_VERSION } from "./recovery-store.mjs";

let directory: string;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync("/tmp/dezfil-recovery-store-");
  db = open(path.join(directory, "metadata.sqlite"));
});
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
function add(id = "ada", isAdmin = true, status: "active" | "invited" | "deactivated" = "active") {
  return insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: "hash",
    isAdmin, status, now: "2026-01-01T00:00:00Z" }, db);
}
function setup() { const user = add(); markOriginalAccount(user.id, db); return user; }
function snapshot() {
  return { version: db.pragma("user_version", { simple: true }), schema: db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
    journal: db.pragma("journal_mode", { simple: true }),
    accounts: db.prepare("SELECT * FROM accounts").all(), original: db.prepare("SELECT * FROM original_account").all() };
}

it("pins compatibility to the shipped schema and opens without changing journal mode or schema", () => {
  expect(RECOVERY_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  setup();
  const before = snapshot();
  const recovery = openRecoveryStore(directory);
  try {
    expect(recovery.pragma("busy_timeout", { simple: true })).toBeGreaterThan(0);
    expect(recovery.pragma("busy_timeout", { simple: true })).toBeLessThanOrEqual(5000);
    expect(selectRecoveryAdmin(recovery)).toEqual({ id: "ada", email: "ada@example.test" });
    expect(snapshot()).toEqual(before);
  } finally { recovery.close(); }
});

it("does not replenish a contention budget already spent opening the store", () => {
  setup();
  const recovery = openRecoveryStore(directory, performance.now() - 1);
  try { expect(recovery.pragma("busy_timeout", { simple: true })).toBe(0); }
  finally { recovery.close(); }
});

it.each(["missing", "empty", "garbage"])("refuses a %s store without creating or changing files", scenario => {
  db.close(); rmSync(directory, { recursive: true });
  // Keep the directory available to distinguish a missing file from a missing directory.
  const scratch = mkdtempSync("/tmp/dezfil-recovery-empty-");
  try {
    if (scenario !== "missing") writeFileSync(path.join(scratch, "metadata.sqlite"), scenario === "empty" ? "" : "not SQLite");
    const before = readdirSync(scratch).map(name => [name, readFileSync(path.join(scratch, name))]);
    expect(() => openRecoveryStore(scratch)).toThrow(/setup|upgrade/i);
    expect(readdirSync(scratch).map(name => [name, readFileSync(path.join(scratch, name))])).toEqual(before);
    expect(() => openRecoveryStore(path.join(scratch, "absent"))).toThrow(/setup/i);
    expect(readdirSync(scratch)).not.toContain("absent");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

it.each(["old", "future", "missing-table", "missing-column", "unclaimed", "no-accounts"])("refuses %s without migration or adoption", scenario => {
  if (scenario !== "no-accounts") setup();
  if (scenario === "old") db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
  if (scenario === "future") db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  if (scenario === "missing-table") db.exec("DROP TABLE auth_tokens");
  if (scenario === "missing-column") db.exec("ALTER TABLE auth_tokens RENAME COLUMN secret_hash TO unexpected_hash");
  if (scenario === "unclaimed") db.exec("DROP TRIGGER original_account_no_delete; DELETE FROM original_account");
  const before = snapshot();
  expect(() => openRecoveryStore(directory)).toThrow(/setup|upgrade/i);
  expect(snapshot()).toEqual(before);
});

it("requires a sole active admin or an exact normalized email, with zero-change refusals", () => {
  setup(); add("other"); add("member", false); add("invited", true, "invited"); add("off", true, "deactivated");
  const before = snapshot();
  expect(() => selectRecoveryAdmin(db)).toThrow(/--email/);
  expect(selectRecoveryAdmin(db, " ADA@EXAMPLE.TEST ")).toEqual({ id: "ada", email: "ada@example.test" });
  for (const email of ["unknown@example.test", "member@example.test", "invited@example.test", "off@example.test", "ada", ""]) {
    expect(() => selectRecoveryAdmin(db, email)).toThrow(/active admin|email/i);
  }
  db.prepare("UPDATE accounts SET is_admin = 0 WHERE id IN ('ada', 'other')").run();
  expect(() => selectRecoveryAdmin(db)).toThrow(/active admin/i);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id IN ('ada', 'other')").run();
  expect(snapshot()).toEqual(before);
  expect(() => validateRecoveryStore(db)).not.toThrow();
});

it.each(["", "https://", "ftp://example.test", "https://user:pass@example.test", "https://example.test/path",
  "https://example.test?query", "https://example.test/#fragment", "https://example.test/?", "https://example.test/#", "https://example.test\\evil",
  "https://example.test/.", "https://example.test/path/..", "https://example.test/%2e"])
("refuses a non-origin %j", origin => { expect(() => recoveryOrigin(origin)).toThrow(/HTTP\/HTTPS/); });
it("accepts explicit HTTP/HTTPS origins without probing a stopped server", () => {
  expect(recoveryOrigin("https://EXAMPLE.test:443/")).toBe("https://example.test");
  expect(recoveryOrigin("http://127.0.0.1:4387")).toBe("http://127.0.0.1:4387");
});
