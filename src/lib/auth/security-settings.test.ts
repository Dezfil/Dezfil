import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { getAccount, insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { writeStoredSettings } from "@/lib/settings/store";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { GET, PATCH } from "@/app/api/instance/settings/route";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { changeOwnPassword, createFirstAccount, signIn } from "./accounts";
import { authenticateSession, issueSession, secretHash, type AuthContext } from "./credentials";
import { inviteAccount, issueSignInLink } from "./admin";
import { gateRequest } from "./gate";
import { redeemSignInLink } from "./links";
import { recoverAdmin } from "./recovery.mjs";
import { securitySettings } from "./security-settings";

/** Runs once after the next password is hashed and before its write: an admin's save landing while the hash is computed. */
const during = vi.hoisted(() => ({ hashed: null as null | (() => void) }));
vi.mock("./passwords", async importOriginal => {
  const actual = await importOriginal<typeof import("./passwords")>();
  return { ...actual, hashPassword: async (...args: Parameters<typeof actual.hashPassword>) => {
    const encoded = await actual.hashPassword(...args);
    const hook = during.hashed;
    during.hashed = null;
    hook?.();
    return encoded;
  } };
});

// Fixture values, written out rather than read from the code under test.
const day = 86_400_000, hour = 3_600_000, start = Date.parse("2026-03-01T00:00:00Z");
const password = "river otter telescope";
const RULES = { "tokens.create": "everyone", "tokens.expiry": "never", "publishing.publish": "everyone",
  "publishing.embedding": "any", "connections.create": "everyone", "imports.links": "everyone" };
const NARROWED = { "tokens.create": "admins", "tokens.expiry": "1y", "publishing.publish": "none",
  "publishing.embedding": "off", "connections.create": "admins", "imports.links": "admins" };
const PRODUCT = { sessionMs: 30 * day, linkMs: 7 * day, failedPerAccount: 5, failedPerAddress: 20, passwordMin: 8,
  tokenExpiry: "never", tokenLifetimeMs: null, rules: RULES };

let db: Database;
beforeEach(() => { db = open(":memory:"); });
afterEach(() => { if (db.open) db.close(); });
function account(id: string, isAdmin = false) {
  return insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: null, isAdmin,
    status: "active", now: new Date(start).toISOString() }, db);
}
const expiry = (secret: string, store = db) =>
  (store.prepare("SELECT expires_at FROM auth_sessions WHERE secret_hash = ?").get(secretHash(secret)) as { expires_at: number }).expires_at;

describe("the Security rows' reader", () => {
  it("resolves the rows from the store it is handed, on every call", () => {
    expect(securitySettings(db)).toEqual(PRODUCT);
    writeStoredSettings({ "security.sessionDays": "1", "security.linkDays": "14", "security.failedPerAccount": 3, "security.failedPerAddress": 10,
      "security.passwordMin": 12, ...NARROWED }, db);
    expect(securitySettings(db)).toEqual({ sessionMs: day, linkMs: 14 * day, failedPerAccount: 3, failedPerAddress: 10, passwordMin: 12,
      tokenExpiry: "1y", tokenLifetimeMs: 365 * day, rules: NARROWED });
    // Another store keeps its own rows: nothing is kept between calls or across stores.
    const other = open(":memory:");
    try { expect(securitySettings(other)).toEqual(PRODUCT); } finally { other.close(); }
    writeStoredSettings({ "security.sessionDays": null, "security.failedPerAccount": null }, db);
    expect(securitySettings(db)).toEqual({ ...PRODUCT, linkMs: 14 * day, failedPerAddress: 10, passwordMin: 12, tokenExpiry: "1y", tokenLifetimeMs: 365 * day,
      rules: NARROWED });
  });

  it("reads a stored value the catalogue no longer accepts as the product's own", () => {
    db.prepare("INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)")
      .run("instance.security.sessionDays", "2", "2026-03-01", "instance.security.failedPerAccount", "2", "2026-03-01",
        "instance.security.passwordMin", "7", "2026-03-01", "instance.publishing.publish", "nobody", "2026-03-01");
    expect(securitySettings(db)).toEqual(PRODUCT);
  });
});

describe("sessions", () => {
  it("keeps the expiry a session holds after a shorter length is stored, and its next use renews it by the stored length", () => {
    const owner = getAccount(account("ada").id, db)!;
    const used = issueSession(owner, db, start), idle = issueSession(owner, db, start), ended = issueSession(owner, db, start);
    expect([used.expiresAt, expiry(used.secret)]).toEqual([start + 30 * day, start + 30 * day]);
    writeStoredSettings({ "security.sessionDays": "1" }, db);
    // Last used five days before, under 30 days: the save ends nothing.
    expect(authenticateSession(used.secret, db, start + 5 * day)?.account.id).toBe("ada");
    expect(expiry(used.secret)).toBe(start + 6 * day);
    expect(authenticateSession(used.secret, db, start + 6 * day - 1)?.account.id).toBe("ada");
    expect(expiry(used.secret)).toBe(start + 7 * day - 1);
    expect(authenticateSession(used.secret, db, start + 8 * day)).toBeNull();
    // An unused session lives to the expiry it holds, and not past it.
    expect(authenticateSession(idle.secret, db, start + 30 * day - 1)?.account.id).toBe("ada");
    expect(authenticateSession(ended.secret, db, start + 30 * day)).toBeNull();
  });

  it("issues a session at the stored length, read at each issue", () => {
    const owner = getAccount(account("ada").id, db)!;
    writeStoredSettings({ "security.sessionDays": "7" }, db);
    expect(issueSession(owner, db, start).expiresAt).toBe(start + 7 * day);
    writeStoredSettings({ "security.sessionDays": "90" }, db);
    const longer = issueSession(owner, db, start);
    expect([longer.expiresAt, expiry(longer.secret)]).toEqual([start + 90 * day, start + 90 * day]);
  });
});

describe("invitation and reset links", () => {
  let admin: AuthContext;
  beforeEach(() => {
    const first = account("admin", true);
    markOriginalAccount(first.id, db);
    admin = authenticateSession(issueSession(first, db, start).secret, db, start)!;
  });

  it("keeps a link issued before a save at its own lifetime and gives one issued after the new lifetime", async () => {
    const before = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const member = account("grace");
    expect(before.expiresAt).toBe(start + 7 * day);
    writeStoredSettings({ "security.linkDays": "1" }, db);
    const saved = start + hour;
    const after = inviteAccount(admin, { name: "Bo", email: "bo@example.test" }, db, saved);
    const reset = issueSignInLink(admin, member.id, db, saved);
    expect([after.expiresAt, reset.expiresAt]).toEqual([saved + day, saved + day]);
    expect(db.prepare("SELECT expires_at FROM auth_links WHERE revoked_at IS NULL ORDER BY expires_at").all())
      .toEqual([{ expires_at: saved + day }, { expires_at: saved + day }, { expires_at: start + 7 * day }]);
    await expect(redeemSignInLink(after.secret!, password, db, saved + day)).rejects.toMatchObject({ code: "invalid_link" });
    await expect(redeemSignInLink(reset.secret, password, db, saved + day)).rejects.toMatchObject({ code: "invalid_link" });
    expect((await redeemSignInLink(before.secret!, password, db, start + 7 * day - 1)).account.id).toBe(before.account.id);
  });

  it("issues a fourteen-day link once fourteen days are stored", () => {
    writeStoredSettings({ "security.linkDays": "14" }, db);
    expect(inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start).expiresAt).toBe(start + 14 * day);
  });
});

describe("the shortest password", () => {
  // Fixtures by length: eight, eleven and twelve characters.
  const eight = "marigold", eleven = "river otter", twelve = "river otters";
  let admin: AuthContext;
  beforeEach(async () => {
    const created = await createFirstAccount({ name: "Ada", email: "ada@example.test", password: eight }, db, start);
    admin = authenticateSession(created.secret, db, start)!;
    writeStoredSettings({ "security.passwordMin": 12 }, db);
  });
  const snapshot = () => ["accounts", "auth_sessions", "auth_links"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

  it("at 12, refuses eleven characters at an invitation's and a reset's redemption and at a change, naming 12 and changing nothing", async () => {
    const invited = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const member = account("grace");
    const reset = issueSignInLink(admin, member.id, db, start);
    for (const attempt of [() => redeemSignInLink(invited.secret!, eleven, db, start), () => redeemSignInLink(reset.secret!, eleven, db, start),
      () => changeOwnPassword(admin, eight, eleven, db, start)]) {
      const before = snapshot();
      await expect(attempt()).rejects.toMatchObject({ code: "weak_password", status: 400, message: "Use at least 12 characters." });
      expect(snapshot()).toEqual(before);
    }
    expect((await redeemSignInLink(invited.secret!, twelve, db, start)).account.id).toBe(invited.account.id);
    expect((await redeemSignInLink(reset.secret, twelve, db, start)).account.id).toBe(member.id);
    await changeOwnPassword(admin, eight, twelve, db, start);
    expect((await signIn("ada@example.test", twelve, db, start)).account.id).toBe(admin.account.id);
  });

  it.each(["an invitation's redemption", "a reset's redemption", "a password change"] as const)(
    "refuses eleven characters at %s when 12 is stored while the hash is computed, consuming and changing nothing", async road => {
      writeStoredSettings({ "security.passwordMin": 8 }, db);
      const link = road === "an invitation's redemption" ? inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start)
        : road === "a reset's redemption" ? issueSignInLink(admin, account("grace").id, db, start) : null;
      const attempt = () => link ? redeemSignInLink(link.secret!, eleven, db, start) : changeOwnPassword(admin, eight, eleven, db, start);
      const before = snapshot();
      let saved = 0;
      // Eleven characters pass the early check at 8; the save lands after the hash and before the write.
      during.hashed = () => { writeStoredSettings({ "security.passwordMin": 12 }, db); saved += 1; };
      await expect(attempt()).rejects.toMatchObject({ code: "weak_password", status: 400, message: "Use at least 12 characters." });
      expect(saved).toBe(1);
      expect(snapshot()).toEqual(before);
    });

  it("keeps signing in an account whose password was set at 8", async () => {
    expect((await signIn("ada@example.test", eight, db, start)).account.id).toBe(admin.account.id);
  });

  it("lets the first account take 8 whatever is stored", async () => {
    const fresh = open(":memory:");
    try {
      writeStoredSettings({ "security.passwordMin": 64 }, fresh);
      await expect(createFirstAccount({ name: "Bo", email: "bo@example.test", password: "seven77" }, fresh, start))
        .rejects.toMatchObject({ code: "weak_password", message: "Use at least 8 characters." });
      expect((await createFirstAccount({ name: "Bo", email: "bo@example.test", password: eight }, fresh, start)).account.isAdmin).toBe(true);
    } finally { fresh.close(); }
  });
});

it("keeps the command-line recovery link at its own fifteen minutes whatever the links' lifetime", () => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "security-recovery-"));
  const store = open(path.join(directory, "metadata.sqlite"));
  try {
    const owner = insertAccount({ id: "ada", name: "Ada", email: "ada@example.test", passwordHash: null, isAdmin: true,
      status: "active", now: new Date(start).toISOString() }, store);
    markOriginalAccount(owner.id, store);
    writeStoredSettings({ "security.linkDays": "14" }, store);
    expect(recoverAdmin({ dataDir: directory, origin: "https://maps.example.test", email: "ada@example.test" }, start).expiresAt)
      .toBe(start + 15 * 60_000);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("the admin at every Security row's strictest", () => {
  afterEach(() => { vi.useRealTimers(); });
  it.each(["cookie", "token"] as const)("keeps the admin's next request by %s after the save", async kind => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const f = instanceSettingsFixture();
    try {
      const url = "http://instance.test/api/instance/settings";
      const strictest = { "security.sessionDays": "1", "security.linkDays": "1", "security.failedPerAccount": 3,
        "security.failedPerAddress": 10, "security.passwordMin": 64, "tokens.create": "admins", "tokens.expiry": "30d" };
      // Five days on, the admin saves by the other credential, so this one was last used five days before.
      vi.setSystemTime(start + 5 * day);
      const other: Record<string, string> = kind === "cookie" ? { authorization: `Bearer ${f.token.secret}` }
        : { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test" };
      const saved = await PATCH(socketRequest(new Request(url, { method: "PATCH",
        headers: { ...other, "content-type": "application/json" }, body: JSON.stringify(strictest) })));
      expect(saved.status).toBe(200);
      const headers: Record<string, string> = kind === "cookie" ? { cookie: `dezfil_session=${f.admin.secret}` } : { authorization: `Bearer ${f.token.secret}` };
      const gated = gateRequest(socketRequest(new Request(url, { headers })));
      expect(gated.headers.get("x-middleware-next")).toBe("1");
      const response = await GET(socketRequest(new Request(url, { headers })));
      expect(response.status).toBe(200);
      expect((await response.json()).settings["security.sessionDays"]).toMatchObject({ value: "1", source: "stored" });
      if (kind === "cookie") {
        expect(gated.headers.get("set-cookie")).toMatch(/Max-Age=86400(;|$)/i);
        expect(expiry(f.admin.secret, f.db)).toBe(start + 6 * day);
      }
    } finally { f.close(); }
  });
});
