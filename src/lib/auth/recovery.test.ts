import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount, markOriginalAccount, listAccounts } from "@/lib/metadata/accounts";
import { issueSession, authenticateSession, authenticateToken, createApiToken } from "./credentials";
import { issueLink } from "./link-issuance.mjs";
import { recoverAdmin, RECOVERY_LIFETIME_MS } from "./recovery.mjs";
import { runAdminRecover } from "../../../scripts/admin-recover.mjs";

let directory: string, db: Database;
const now = Date.parse("2026-01-01T00:00:00Z");
const origin = "https://maps.example.test";
function add(id: string) {
  const account = insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: "existing hash",
    isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
  const session = issueSession(account, db, now);
  const context = authenticateSession(session.secret, db, now)!;
  const token = createApiToken(context, "API and MCP", db, now);
  const link = db.transaction(() => issueLink(id, "reset", db, now)).immediate();
  return { account, session, token, link };
}
function snapshot(id?: string) {
  return ["accounts", "auth_sessions", "auth_tokens", "auth_links"].map(table => db.prepare(
    `SELECT * FROM ${table}${id ? ` WHERE ${table === "accounts" ? "id" : "account_id"} = ?` : ""} ORDER BY id`,
  ).all(...(id ? [id] : [])));
}
beforeEach(() => { directory = mkdtempSync("/tmp/dezfil-admin-recovery-"); db = open(path.join(directory, "metadata.sqlite")); });
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

it("atomically replaces links and revokes the target password, sessions and API/MCP tokens only", () => {
  const target = add("ada"); markOriginalAccount("ada", db);
  const other = add("lin"); const beforeOther = snapshot("lin");
  const result = recoverAdmin({ dataDir: directory, origin, email: " ADA@example.test " }, now + 1);
  expect(RECOVERY_LIFETIME_MS).toBe(15 * 60_000);
  expect(result).toMatchObject({ account: { id: "ada", email: "ada@example.test" }, expiresAt: now + 1 + 15 * 60_000 });
  const url = new URL(result.url);
  expect(url.origin).toBe(origin); expect(url.pathname).toBe("/accept"); expect(url.search).toBe("");
  const secret = new URLSearchParams(url.hash.slice(1)).get("secret")!;
  expect(secret).toMatch(/^dz_link_[\w-]{43}$/);
  expect(authenticateSession(target.session.secret, db, now + 1)).toBeNull();
  expect(authenticateToken(target.token.secret, db, now + 1)).toBeNull();
  expect(db.prepare("SELECT password_hash FROM accounts WHERE id = 'ada'").get()).toEqual({ password_hash: null });
  expect(db.prepare("SELECT revoked_at FROM auth_links WHERE account_id = 'ada' ORDER BY created_at").all())
    .toEqual([{ revoked_at: now + 1 }, { revoked_at: null }]);
  expect(snapshot("lin")).toEqual(beforeOther);
  expect(authenticateToken(other.token.secret, db, now + 1)).not.toBeNull();
  expect(JSON.stringify(snapshot())).not.toContain(secret);
  expect(JSON.stringify(listAccounts(db))).not.toMatch(/secret|password|hash/);
  expect(listAccounts(db)[0]).toMatchObject({ id: "ada", isAdmin: true, isOriginal: true, sqlName: target.account.sqlName });
});

it("rolls back every revocation if replacement insertion fails and prints no link", () => {
  add("ada"); markOriginalAccount("ada", db);
  db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON auth_links BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const before = snapshot();
  const output: string[] = [], errors: string[] = [];
  expect(runAdminRecover(["--data-dir", directory, "--origin", origin],
    { isTTY: true, write: value => output.push(value), error: value => errors.push(value) })).toBe(1);
  expect(snapshot()).toEqual(before); expect(output).toEqual([]);
  expect(errors.join("")).not.toMatch(/dz_link_|existing hash|injected failure/);
});

it("requires terminal output before changing credentials, and discloses only account, expiry and one fragment link", () => {
  const target = add("ada"); markOriginalAccount("ada", db);
  const before = snapshot(); const output: string[] = [], errors: string[] = [];
  const args = ["--data-dir", directory, "--origin", origin];
  const io = { isTTY: false, write: (value: string) => output.push(value), error: (value: string) => errors.push(value) };
  expect(runAdminRecover(args, io)).toBe(1); expect(snapshot()).toEqual(before); expect(output).toEqual([]);
  expect(errors.join("")).toMatch(/terminal/);
  errors.length = 0;
  expect(runAdminRecover(args, { ...io, isTTY: true, write: value => {
    // A separate connection observes revocation before any disclosure.
    expect(db.prepare("SELECT password_hash FROM accounts WHERE id = 'ada'").get()).toEqual({ password_hash: null });
    expect(authenticateToken(target.token.secret, db, now)).toBeNull();
    output.push(value);
  } })).toBe(0);
  expect(output).toHaveLength(1); expect(errors).toEqual([]);
  expect(output[0].match(/dz_link_/g)).toHaveLength(1);
  expect(output[0]).toContain('"ada@example.test"'); expect(output[0]).toMatch(/Expires: \d{4}-\d\d-\d\dT/);
  for (const secret of [target.session.secret, target.token.secret, target.link.secret, "existing hash"]) expect(output[0]).not.toContain(secret);
});

it.each(["unknown", "member", "invited", "deactivated", "ambiguous", "origin"])("refuses %s through the command without changing any credentials", scenario => {
  add("ada"); markOriginalAccount("ada", db); add("lin");
  if (scenario === "member") db.exec("UPDATE accounts SET is_admin = 0 WHERE id = 'lin'");
  if (scenario === "invited" || scenario === "deactivated") db.prepare("UPDATE accounts SET status = ? WHERE id = 'lin'").run(scenario);
  const before = snapshot(), output: string[] = [], errors: string[] = [];
  const args = ["--data-dir", directory, "--origin", scenario === "origin" ? "https://example.test/path" : origin];
  if (scenario !== "ambiguous") args.push("--email", scenario === "unknown" ? "unknown@example.test" : "lin@example.test");
  expect(runAdminRecover(args, { isTTY: true, write: value => output.push(value), error: value => errors.push(value) })).toBe(1);
  expect(snapshot()).toEqual(before); expect(output).toEqual([]);
  expect(errors.join("")).toMatch(/active admin|--email|origin/i);
});

it.each([[], ["--data-dir", "x"], ["--origin", origin], ["--wat", "x"], ["--help", "--origin", origin],
  ["--data-dir", "x", "--origin", origin, "--origin", origin], ["--email"]].map(args => ({ args })))("rejects invalid command arguments $args", ({ args }) => {
  const output: string[] = [], errors: string[] = [];
  expect(runAdminRecover(args, { isTTY: true, write: value => output.push(value), error: value => errors.push(value) })).toBe(1);
  expect(output).toEqual([]); expect(errors.join("")).toMatch(/Usage:/);
});
