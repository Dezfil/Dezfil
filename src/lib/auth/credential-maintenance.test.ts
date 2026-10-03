import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { insertLink, insertSession, insertToken } from "@/lib/metadata/auth-credentials";
import { authenticateSession, authenticateToken, listApiTokens, revokeApiToken, secretHash, SESSION_LIFETIME_MS } from "./credentials";

import { credentialMaintenance, maintainCredentials } from "./credential-maintenance";
import { credentialPage, removeExpiredCredentials } from "@/lib/metadata/credential-maintenance";
import { issueLink } from "./link-issuance.mjs";
import { redeemSignInLink } from "./links";
import { signIn } from "./accounts";
import { hashPassword } from "./passwords";

const day = 86_400_000, now = Date.parse("2026-07-01T00:00:00Z");
let db: Database;
beforeEach(() => {
  db = open(":memory:");
  insertAccount({ id: "account", name: "Reader", email: "reader@example.test", passwordHash: "hash",
    isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
});
afterEach(() => db.close());
function session(id: string, expires = now - day, revoked: number | null = null) {
  insertSession({ id, account_id: "account", secret_hash: secretHash(id), created_at: expires - 30 * day,
    expires_at: expires, last_used_at: expires - 30 * day, revoked_at: revoked }, db);
}
function link(id: string, expires = now - day, consumed: number | null = null, revoked: number | null = null) {
  insertLink({ id, account_id: "account", secret_hash: secretHash(id), kind: "reset", created_at: expires - 7 * day,
    expires_at: expires, consumed_at: consumed, revoked_at: revoked }, db);
}
function token(id: string, revoked: number | null = now - 30 * day) {
  insertToken({ id, account_id: "account", secret_hash: secretHash(id), name: id,
    created_at: now - 100 * day, last_used_at: null, revoked_at: revoked }, db);
}
function ids(kind: string) { return db.prepare(`SELECT id FROM auth_${kind} ORDER BY id`).all().map(row => (row as { id: string }).id); }

it("removes only eligible rows in every credential state at the exact retention boundary", () => {
  for (const [name, flag] of [["active", null], ["revoked", now - 40 * day]] as const) {
    session(`old-${name}`, now - day, flag);
    session(`margin-${name}`, now - day + 1, flag);
    session(`future-${name}`, now + day, flag);
  }
  for (const [name, consumed, revoked] of [["unused", null, null], ["consumed", now - 40 * day, null], ["revoked", null, now - 40 * day]] as const) {
    link(`old-${name}`, now - day, consumed, revoked);
    link(`margin-${name}`, now - day + 1, consumed, revoked);
    link(`future-${name}`, now + day, consumed, revoked);
  }
  token("old"); token("margin", now - 30 * day + 1); token("recent", now); token("live", null);
  expect([ids("sessions").length, ids("links").length, ids("tokens").length]).toEqual([6, 9, 4]);
  authenticateToken("unknown", db, now);
  expect(ids("sessions")).toEqual(["future-active", "future-revoked", "margin-active", "margin-revoked"]);
  expect(ids("links")).toEqual(["future-consumed", "future-revoked", "future-unused", "margin-consumed", "margin-revoked", "margin-unused"]);
  expect(ids("tokens")).toEqual(["live", "margin", "recent"]);
});


it("bounds examined rows, including live rows, and resumes every store without an hourly delay", () => {
  db.transaction(() => { for (let i = 0; i < 1251; i++) {
    const id = String(i).padStart(4, "0");
    session(id, i < 500 ? now + day : now - day);
    link(id); token(id);
  } })();
  const sweep = credentialMaintenance();
  expect(sweep(db, () => now)).toEqual({ examined: { sessions: 500, links: 500, tokens: 500 }, removed: { sessions: 0, links: 500, tokens: 500 }, complete: false });
  expect(sweep(db, () => now)).toEqual({ examined: { sessions: 500, links: 500, tokens: 500 }, removed: { sessions: 500, links: 500, tokens: 500 }, complete: false });
  expect(sweep(db, () => now)).toEqual({ examined: { sessions: 251, links: 251, tokens: 251 }, removed: { sessions: 251, links: 251, tokens: 251 }, complete: true });
  expect(ids("sessions")).toHaveLength(500); expect(ids("links")).toEqual([]); expect(ids("tokens")).toEqual([]);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM auth_sessions WHERE id > ? ORDER BY id LIMIT ?").all("0500", 500);
  expect(JSON.stringify(plan)).toContain("SEARCH"); expect(JSON.stringify(plan)).not.toContain("SCAN");
});

it("starts the hourly interval at completion, then drains a new pass on access", () => {
  const sweep = credentialMaintenance(); let time = now;
  session("first");
  const page = vi.spyOn(db, "transaction");
  expect(sweep(db, () => time++)?.complete).toBe(true);
  const completedAt = time - 1;
  session("next"); page.mockClear();
  expect(sweep(db, () => completedAt + 3_600_000 - 1)).toBeNull(); expect(page).not.toHaveBeenCalled();
  expect(sweep(db, () => completedAt + 3_600_000)?.removed.sessions).toBe(1);
  page.mockRestore();
});

it("skips caller transactions and retries after failure without losing the page", () => {
  session("old"); const sweep = credentialMaintenance();
  db.transaction(() => { expect(sweep(db, () => now)).toBeNull(); })();
  db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => sweep(db, () => now)).toThrow("injected"); expect(ids("sessions")).toEqual(["old"]);
  db.exec("DROP TRIGGER reject_cleanup");
  expect(sweep(db, () => now)?.removed.sessions).toBe(1);
});

it("keeps new rows behind the cursor until the next pass and restarts safely mid-backlog", () => {
  db.transaction(() => { for (let i = 0; i < 1001; i++) session(`b${String(i).padStart(4, "0")}`); })();
  const sweep = credentialMaintenance();
  expect(sweep(db, () => now)?.examined.sessions).toBe(500);
  session("a-late-insertion");
  expect(sweep(db, () => now)?.examined.sessions).toBe(500);
  expect(sweep(db, () => now)?.examined.sessions).toBe(1);
  expect(ids("sessions")).toEqual(["a-late-insertion"]);
  const restarted = credentialMaintenance();
  expect(restarted(db, () => now)?.removed.sessions).toBe(1);
});

it("a sub-day forward clock step preserves credentials usable after correction", () => {
  session("rolling", now + 60_000); link("link", now + 60_000); token("live", null);
  const sweep = credentialMaintenance();
  expect(sweep(db, () => now + day - 1)?.removed).toEqual({ sessions: 0, links: 0, tokens: 0 });
  expect(authenticateSession("rolling", db, now)).not.toBeNull();
  expect(authenticateToken("live", db, now)).not.toBeNull();
  expect(ids("links")).toEqual(["link"]);
  expect(sweep(db, () => now)).toBeNull();
  expect(sweep(db, () => now + day + 3_600_000)?.removed.links).toBe(1);
});

it("rechecks a renewed session and a replacement link after the page was selected", async () => {
  session("rolling", now + 1); link("redeem", now + 1);
  const sessions = credentialPage(db, "sessions", undefined), links = credentialPage(db, "links", undefined);
  expect(authenticateSession("rolling", db, now)).not.toBeNull();
  const entered = await redeemSignInLink("redeem", "river otter telescope", db, now);
  const replacement = db.transaction(() => issueLink("account", "reset", db, now)).immediate();
  // Even a sweep clock one day ahead must read the renewed expiry, not its page snapshot.
  expect(removeExpiredCredentials(db, "sessions", sessions, now + day + 1)).toBe(0);
  expect(removeExpiredCredentials(db, "links", links, now + day + 1)).toBe(1);
  expect(authenticateSession(entered.secret, db, now)).not.toBeNull();
  expect(db.prepare("SELECT expires_at FROM auth_links WHERE secret_hash = ?").get(secretHash(replacement.secret)))
    .toEqual({ expires_at: now + 7 * day });
  const redeemed = await redeemSignInLink(replacement.secret, "river otter telescope", db, now);
  expect(authenticateSession(redeemed.secret, db, now)).not.toBeNull();
});

it("preserves a redemption waiting for password work while maintenance runs", async () => {
  link("redeem", now + day);
  const entered = redeemSignInLink("redeem", "river otter telescope", db, now);
  session("old");
  const swept = credentialMaintenance()(db, () => now);
  const result = await entered;
  expect(swept?.removed.sessions).toBe(1);
  expect(authenticateSession(result.secret, db, now)).not.toBeNull();
  expect(ids("links")).toEqual(["redeem"]);
});

it("keeps recent token history, hides removed rows and gives the exact unknown-id refusal", () => {
  token("live", null); token("recent", now - day); token("old");
  const context = authenticateToken("live", db, now)!;
  expect(listApiTokens(context, db, now).map(row => [row.id, row.revokedAt])).toEqual([
    ["live", null], ["recent", new Date(now - day).toISOString()],
  ]);
  for (const id of ["old", "unknown"]) {
    expect(() => revokeApiToken(context, id, db, now)).toThrow(expect.objectContaining({ code: "not_found", status: 404, message: "Token not found." }));
  }
  expect(authenticateToken("old", db, now)).toBeNull();
});

it("repeated sign-ins retain thirty-day sessions, then access drains the inactive backlog", async () => {
  db.prepare("UPDATE accounts SET password_hash = ?").run(await hashPassword("river otter telescope"));
  const entered = [];
  for (let i = 0; i < 6; i++) entered.push(await signIn("reader@example.test", "river otter telescope", db, now + i));
  expect(ids("sessions")).toHaveLength(6);
  const renewedAt = now + SESSION_LIFETIME_MS - 1;
  expect(authenticateSession(entered[0].secret, db, renewedAt)).not.toBeNull();
  authenticateToken("unknown", db, now + SESSION_LIFETIME_MS + day + 6);
  expect(ids("sessions")).toHaveLength(1);
  expect(authenticateSession(entered[0].secret, db, now + SESSION_LIFETIME_MS + day + 6)).not.toBeNull();
});

it("credential accesses continue a shared incomplete pass", () => {
  db.transaction(() => { for (let i = 0; i < 1501; i++) token(String(i).padStart(4, "0")); })();
  expect(maintainCredentials(db, now)?.examined.tokens).toBe(500);
  authenticateToken("unknown", db, now); expect(ids("tokens")).toHaveLength(501);
  authenticateSession("unknown", db, now); expect(ids("tokens")).toHaveLength(1);
  authenticateToken("unknown", db, now); expect(ids("tokens")).toEqual([]);
});
