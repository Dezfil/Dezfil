import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { issueSession, authenticateSession, createApiToken } from "./credentials";
import { issueLink, secretHash } from "./link-issuance.mjs";
import { recoverAdmin } from "./recovery.mjs";
import { redeemSignInLink } from "./links";
import { recoveryProcess } from "./recovery-process-fixture";

let directory: string, db: Database;
const now = Date.parse("2026-01-01T00:00:00Z"), password = "paper cranes after midnight";
const children: ReturnType<typeof recoveryProcess>[] = [];
function worker(pauseAfterHash = false) { const child = recoveryProcess(directory, pauseAfterHash); children.push(child); return child; }
function secret(url: string) { return new URLSearchParams(new URL(url).hash.slice(1)).get("secret")!; }
function issue(at = now) { return recoverAdmin({ dataDir: directory, origin: "https://maps.example.test" }, at); }
function snapshot(id?: string) {
  return ["accounts", "auth_links", "auth_sessions", "auth_tokens"].map(table => db.prepare(
    `SELECT * FROM ${table}${id ? ` WHERE ${table === "accounts" ? "id" : "account_id"} = ?` : ""} ORDER BY id`,
  ).all(...(id ? [id] : [])));
}
beforeEach(() => {
  directory = mkdtempSync("/tmp/dezfil-recovery-process-"); db = open(path.join(directory, "metadata.sqlite"));
  for (const id of ["ada", "lin"]) {
    const account = insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: "existing hash",
      isAdmin: id === "ada", status: "active", now: new Date(now).toISOString() }, db);
    const session = issueSession(account, db, now);
    createApiToken(authenticateSession(session.secret, db, now)!, "API and MCP", db, now);
    db.transaction(() => issueLink(id, "reset", db, now)).immediate();
  }
  markOriginalAccount("ada", db);
});
afterEach(async () => {
  for (const child of children) child.stop();
  await Promise.allSettled(children.splice(0).map(child => child.result));
  if (db.open) db.close(); rmSync(directory, { recursive: true, force: true });
});

it.each(["open", "closed"])("issues with the server store %s, then redeems after reopen without touching the other account", async state => {
  const beforeOther = snapshot("lin");
  if (state === "closed") db.close();
  const issuer = worker(); await issuer.ready; issuer.start({ kind: "issue", now });
  const issued = await issuer.result; expect(issued.ok).toBe(true); expect(issued.expiresAt).toBe(now + 900_000);
  if (db.open) db.close(); db = open(path.join(directory, "metadata.sqlite"));
  const link = secret(issued.url!);
  const beforeWeak = snapshot();
  await expect(redeemSignInLink(link, "password", db, now)).rejects.toMatchObject({ code: "weak_password" });
  expect(snapshot()).toEqual(beforeWeak);
  const redeem = worker(); await redeem.ready; redeem.start({ kind: "redeem", secret: link, password, now: now + 899_999 });
  const accepted = await redeem.result;
  expect(accepted).toMatchObject({ ok: true, account: { id: "ada", isAdmin: true } });
  expect(authenticateSession(accepted.secret!, db, now + 899_999)?.account.id).toBe("ada");
  expect(snapshot("lin")).toEqual(beforeOther);
  const after = snapshot();
  await expect(redeemSignInLink(link, password, db, now + 899_999)).rejects.toMatchObject({ code: "invalid_link" });
  expect(snapshot()).toEqual(after);
});

it.each(["expired", "replaced", "deactivated"])("refuses a %s recovery link after restart without any effects", async state => {
  const first = issue();
  if (state === "replaced") issue(now + 1);
  if (state === "deactivated") db.exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'");
  const before = snapshot(); db.close();
  const redeem = worker(); await redeem.ready;
  redeem.start({ kind: "redeem", secret: secret(first.url), password, now: state === "expired" ? now + 900_000 : now + 2 });
  expect(await redeem.result).toMatchObject({ ok: false, code: "invalid_link" });
  db = open(path.join(directory, "metadata.sqlite")); expect(snapshot()).toEqual(before);
});

it("serializes simultaneous issuance and leaves only the last committed link redeemable", async () => {
  const beforeOther = snapshot("lin"), issuers = [worker(), worker()];
  await Promise.all(issuers.map(child => child.ready)); issuers.forEach(child => child.start({ kind: "issue", now }));
  const results = await Promise.all(issuers.map(child => child.result));
  expect(results.map(result => result.ok)).toEqual([true, true]);
  const rows = db.prepare("SELECT secret_hash, revoked_at FROM auth_links WHERE account_id = 'ada' AND revoked_at IS NULL").all() as { secret_hash: string }[];
  expect(rows).toHaveLength(1);
  const winner = results.find(result => secretHash(secret(result.url!)) === rows[0].secret_hash)!;
  const loser = results.find(result => result !== winner)!;
  const before = snapshot();
  await expect(redeemSignInLink(secret(loser.url!), password, db, now)).rejects.toMatchObject({ code: "invalid_link" });
  expect(snapshot()).toEqual(before);
  expect((await redeemSignInLink(secret(winner.url!), password, db, now)).account.id).toBe("ada");
  expect(snapshot("lin")).toEqual(beforeOther);
});

it("consumes a recovery link only once across simultaneous processes", async () => {
  const link = secret(issue().url), beforeOther = snapshot("lin"), redeemers = [worker(true), worker(true)];
  await Promise.all(redeemers.map(child => child.ready));
  redeemers.forEach(child => child.start({ kind: "redeem", secret: link, password, now }));
  await Promise.all(redeemers.map(child => child.hashed())); redeemers.forEach(child => child.resume());
  const results = await Promise.all(redeemers.map(child => child.result));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)).toMatchObject({ code: "invalid_link" });
  expect(db.prepare("SELECT count(*) AS n FROM auth_sessions WHERE account_id = 'ada' AND revoked_at IS NULL").get()).toEqual({ n: 1 });
  expect(snapshot("lin")).toEqual(beforeOther);
});

it("refuses a redemption paused during password work when recovery replaces its link", async () => {
  const link = secret(issue().url), redeem = worker(true); await redeem.ready;
  redeem.start({ kind: "redeem", secret: link, password, now }); await redeem.hashed();
  const replacement = issue(now + 1), before = snapshot(); redeem.resume();
  expect(await redeem.result).toMatchObject({ ok: false, code: "invalid_link" });
  expect(snapshot()).toEqual(before);
  const accepted = await redeemSignInLink(secret(replacement.url), password, db, now + 2);
  issue(now + 3);
  expect(authenticateSession(accepted.secret, db, now + 3)).toBeNull();
});

it.each([false, true])("waits for transient contention and rechecks current admin eligibility (deactivated: %s)", async deactivate => {
  const issuer = worker(), locker = worker(); await Promise.all([issuer.ready, locker.ready]);
  const before = snapshot();
  locker.start({ kind: "lock", duration: 800, deactivate }); await locker.locked();
  issuer.start({ kind: "issue", now }); const result = await issuer.result; await locker.result;
  expect(result.elapsed).toBeGreaterThan(400); expect(result.elapsed).toBeLessThan(5000);
  expect(result.ok).toBe(!deactivate);
  if (deactivate) {
    expect(result.url).toBeUndefined(); expect(result.message).toMatch(/active admin/);
    db.exec("UPDATE accounts SET status = 'active' WHERE id = 'ada'"); expect(snapshot()).toEqual(before);
  }
});

it.each(["WAL", "DELETE"])("bounds contention to five seconds in %s and returns retry advice with no changes or link", async journal => {
  db.pragma(`journal_mode = ${journal}`);
  const issuer = worker(); await issuer.ready; const before = snapshot();
  db.exec(journal === "DELETE" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
  try {
    issuer.start({ kind: "issue", now }); const result = await issuer.result;
    expect(result).toMatchObject({ ok: false }); expect(result.message).toMatch(/five seconds.*Retry/i);
    expect(result.url).toBeUndefined(); expect(result.elapsed).toBeGreaterThanOrEqual(4700);
    expect(result.elapsed).toBeLessThan(6200); expect(snapshot()).toEqual(before);
  } finally { db.exec("ROLLBACK"); }
});

it("refuses redirected command output in a real Node process before any credential mutation", () => {
  const before = snapshot();
  const result = spawnSync(process.execPath, ["scripts/admin-recover.mjs", "--data-dir", directory, "--origin", "https://maps.example.test"],
    { encoding: "utf8", env: { ...process.env, DEZFIL_DATA_DIR: directory } });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toMatch(/terminal/);
  expect(result.stderr).not.toMatch(/dz_link_|existing hash/); expect(snapshot()).toEqual(before);
});
