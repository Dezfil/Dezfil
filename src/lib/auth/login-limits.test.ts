import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { writeStoredSettings } from "@/lib/settings/store";
import { AuthError } from "./errors";
import { createFirstAccount, signIn } from "./accounts";
import { secretHash } from "./credentials";
import { LOGIN_WINDOW_MS, signInFromRequest, withLoginLimit } from "./login-limits";

let db: Database;
const time = 1_000_000;
// The stored counts' defaults, as fixtures: the product's counts before they were settings.
const LOGIN_ACCOUNT_LIMIT = 5, LOGIN_SOURCE_LIMIT = 20;
const denied = async () => { throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401); };
const allowed = async () => "signed in";
beforeEach(() => { db = open(":memory:"); });
afterEach(() => db.close());
const attempt = (email: string, source: string, operation: () => Promise<string> = denied, now = time) => withLoginLimit(email, source, operation, db, () => now);
async function fail(email: string, source: string) {
  await expect(attempt(email, source)).rejects.toMatchObject({ code: "invalid_credentials" });
}

it("admits the correct password from a clean source despite a drip of account failures", async () => {
  const email = "person@example.test", password = "field notebooks at dawn";
  const first = await createFirstAccount({ name: "Person", email, password }, db);
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) {
    await expect(attempt(" Person@Example.Test ", `192.0.2.${index + 1}`, denied, time + index * 60_000))
      .rejects.toMatchObject({ code: "invalid_credentials" });
  }
  expect(db.prepare("SELECT failures FROM auth_login_limits WHERE bucket = ?").get(`account:${secretHash(email)}`))
    .toEqual({ failures: LOGIN_ACCOUNT_LIMIT });
  await expect(withLoginLimit(email, "198.51.100.1", () => signIn(email, password, db), db,
    () => time + LOGIN_WINDOW_MS - 1)).resolves.toMatchObject({ account: { id: first.account.id } });
  expect(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 2 });
});

it.each(["person@example.test", "unrelated@example.test"])("still throttles the correct password when the source recently failed %s", async failedEmail => {
  const email = "person@example.test", password = "field notebooks at dawn";
  await createFirstAccount({ name: "Person", email, password }, db);
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail(email, `192.0.2.${index + 1}`);
  const source = failedEmail === email ? "192.0.2.1" : "198.51.100.1";
  if (failedEmail !== email) await fail(failedEmail, source);
  const operation = vi.fn(() => signIn(email, password, db));
  await expect(withLoginLimit(email, source, operation, db, () => time)).rejects.toMatchObject({ code: "rate_limited" });
  expect(operation).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
});

it("counts a clean source's wrong password against both buckets even when the account budget is tripped", async () => {
  const email = "person@example.test", source = "198.51.100.1", password = "field notebooks at dawn";
  await createFirstAccount({ name: "Person", email, password }, db);
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail(email, `192.0.2.${index + 1}`);
  await expect(withLoginLimit(email, source, () => signIn(email, "incorrect", db), db, () => time))
    .rejects.toMatchObject({ code: "invalid_credentials" });
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`account:${secretHash(email)}`))
    .toEqual({ failures: LOGIN_ACCOUNT_LIMIT + 1, pending: 0 });
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash(source)}`))
    .toEqual({ failures: 1, pending: 0 });
  await expect(withLoginLimit(email, source, () => signIn(email, password, db), db, () => time))
    .rejects.toMatchObject({ code: "rate_limited" });
  expect(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
});

it("throttles normalized accounts for a source with recent failures and states exactly when retry is possible", async () => {
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail(" Person@Example.Test ", `192.0.2.${index + 1}`);
  const operation = vi.fn(allowed);
  await expect(attempt("person@example.test", "192.0.2.1", operation)).rejects.toMatchObject({
    code: "rate_limited", status: 429,
    extra: { retryAfter: LOGIN_WINDOW_MS / 1000, retryAt: new Date(time + LOGIN_WINDOW_MS).toISOString() },
  });
  expect(operation).not.toHaveBeenCalled();
});

it("throttles a source across changing emails without charging another source", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT; index++) await fail(`person${index}@example.test`, "192.0.2.1");
  await expect(attempt("other@example.test", "192.0.2.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
  expect(await attempt("other@example.test", "192.0.2.2", allowed)).toBe("signed in");
});

it("recovers after the stated interval without admin intervention", async () => {
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail("person@example.test", "192.0.2.1");
  await expect(attempt("person@example.test", "192.0.2.1", allowed, time + LOGIN_WINDOW_MS - 1))
    .rejects.toMatchObject({ code: "rate_limited", extra: { retryAfter: 1 } });
  expect(await attempt("person@example.test", "192.0.2.1", allowed, time + LOGIN_WINDOW_MS)).toBe("signed in");
});

it("advertises recovery when the source becomes clean before the account window expires", async () => {
  await expect(attempt("unrelated@example.test", "198.51.100.1", denied, time - 60_000))
    .rejects.toMatchObject({ code: "invalid_credentials" });
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail("person@example.test", `192.0.2.${index + 1}`);
  const retryAt = time - 60_000 + LOGIN_WINDOW_MS;
  await expect(attempt("person@example.test", "198.51.100.1", allowed, retryAt - 1))
    .rejects.toMatchObject({ code: "rate_limited", extra: { retryAfter: 1, retryAt: new Date(retryAt).toISOString() } });
  expect(await attempt("person@example.test", "198.51.100.1", allowed, retryAt)).toBe("signed in");
});

it("does not let a successful login reset a source's failures against unrelated accounts", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT - 1; index++) await fail(`person${index}@example.test`, "192.0.2.1");
  expect(await attempt("valid@example.test", "192.0.2.1", allowed)).toBe("signed in");
  await fail("next@example.test", "192.0.2.1");
  await expect(attempt("another@example.test", "192.0.2.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
});

it("reserves account capacity before asynchronous password work for sources with recent failures", async () => {
  await fail("unrelated@example.test", "198.51.100.1");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempts = Array.from({ length: LOGIN_ACCOUNT_LIMIT }, (_, index) =>
    attempt("person@example.test", `192.0.2.${index + 1}`, async () => { await held; return "signed in"; }));
  try {
    await expect(attempt("person@example.test", "198.51.100.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
  } finally { release(); await Promise.all(attempts); }
});

it("reserves source capacity before asynchronous password work even without recent failures", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempts = Array.from({ length: LOGIN_SOURCE_LIMIT }, (_, index) =>
    attempt(`person${index}@example.test`, "192.0.2.1", async () => { await held; return "signed in"; }));
  try {
    await expect(attempt("other@example.test", "192.0.2.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
  } finally { release(); await Promise.all(attempts); }
});

it("refunds infrastructure failures and successful attempts", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT + 1; index++) {
    await expect(attempt("person@example.test", "192.0.2.1", async () => { throw new Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
    expect(await attempt("person@example.test", "192.0.2.1", allowed)).toBe("signed in");
  }
});

describe("the stored counts", () => {
  const store = (patch: Record<string, unknown>) => writeStoredSettings(patch, db);
  const paused = (retryAt: number, at: number) => ({ code: "rate_limited", status: 429,
    extra: { retryAt: new Date(retryAt).toISOString(), retryAfter: Math.ceil((retryAt - at) / 1000) } });

  it("at 3 per account and 10 per address, pauses the account's fourth attempt after three failures from a failing address, never past the window", async () => {
    store({ "security.failedPerAccount": 3, "security.failedPerAddress": 10 });
    for (let index = 0; index < 3; index++) {
      await expect(attempt("person@example.test", "192.0.2.1", denied, time + index * 60_000)).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    const operation = vi.fn(allowed), fourth = time + 3 * 60_000;
    await expect(attempt("person@example.test", "192.0.2.1", operation, fourth)).rejects.toMatchObject(paused(time + LOGIN_WINDOW_MS, fourth));
    expect(operation).not.toHaveBeenCalled();
    // The pause ends when the window that began with the first failure ends.
    await expect(attempt("person@example.test", "192.0.2.1", operation, time + LOGIN_WINDOW_MS - 1)).rejects.toMatchObject({ code: "rate_limited" });
    expect(await attempt("person@example.test", "192.0.2.1", operation, time + LOGIN_WINDOW_MS)).toBe("signed in");
  });

  it("pauses the next attempt once the count is lowered below the failures already counted", async () => {
    for (let index = 0; index < 4; index++) await fail("person@example.test", "192.0.2.1");
    store({ "security.failedPerAccount": 3 });
    const operation = vi.fn(allowed);
    await expect(attempt("person@example.test", "192.0.2.1", operation)).rejects.toMatchObject(paused(time + LOGIN_WINDOW_MS, time));
    expect(operation).not.toHaveBeenCalled();
  });

  it("at 10 per address, pauses the address's eleventh attempt across accounts and charges no other address", async () => {
    store({ "security.failedPerAccount": 3, "security.failedPerAddress": 10 });
    for (let index = 0; index < 10; index++) await fail(`person${index}@example.test`, "192.0.2.1");
    await expect(attempt("other@example.test", "192.0.2.1", allowed)).rejects.toMatchObject(paused(time + LOGIN_WINDOW_MS, time));
    expect(await attempt("other@example.test", "192.0.2.2", allowed)).toBe("signed in");
  });

  it("admits more failures once the counts are raised", async () => {
    store({ "security.failedPerAccount": 100, "security.failedPerAddress": 1000 });
    for (let index = 0; index < 30; index++) await fail("person@example.test", "192.0.2.1");
    expect(await attempt("person@example.test", "192.0.2.1", allowed)).toBe("signed in");
  });
});

it("refuses sign-in without the preload rather than falling back to submitted forwarding headers", async () => {
  const request = new Request("http://instance.test/api/auth/sign-in", { headers: {
    "x-forwarded-for": "192.0.2.1", "x-dezfil-ingress": "forged", "x-forwarded-proto": "https",
  } });
  await expect(signInFromRequest(request, "person@example.test", "anything", db)).rejects.toMatchObject({ code: "ingress_unavailable" });
  expect(db.prepare("SELECT * FROM auth_sessions").all()).toEqual([]);
});

it("counts failed sign-ins from every address of an IPv6 /64 against one address budget", async () => {
  const sources = Array.from({ length: LOGIN_SOURCE_LIMIT }, (_, index) => `2001:db8:0:1::${(index + 1).toString(16)}`);
  for (const [index, source] of sources.entries()) await fail(`person${index}@example.test`, source);
  expect(db.prepare("SELECT failures FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash("2001:db8:0:1::/64")}`))
    .toEqual({ failures: LOGIN_SOURCE_LIMIT });
  // A fresh address in that /64 is paused; the next /64 and an IPv4 source are not.
  await expect(attempt("fresh@example.test", "2001:db8:0:1:ffff::1")).rejects.toMatchObject({ code: "rate_limited" });
  await expect(attempt("fresh@example.test", "2001:db8:0:2::1", allowed)).resolves.toBe("signed in");
  await expect(attempt("fresh@example.test", "192.0.2.1", allowed)).resolves.toBe("signed in");
});

it("counts failed sign-ins through a NAT64 translator against the IPv4 client's budget, not the translator's /64", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT; index++) await fail(`person${index}@example.test`, index % 2 ? "64:ff9b::c000:201" : "64:ff9b::192.0.2.1");
  // Another client behind the same translator is not paused; the same
  // client reaching the instance directly is.
  await expect(attempt("fresh@example.test", "64:ff9b::192.0.2.2", allowed)).resolves.toBe("signed in");
  await expect(attempt("fresh@example.test", "192.0.2.1")).rejects.toMatchObject({ code: "rate_limited" });
  expect(db.prepare("SELECT failures FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash("192.0.2.1")}`))
    .toEqual({ failures: LOGIN_SOURCE_LIMIT });
});

it("keeps IPv4 sources, mapped or not, in their own address budgets", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT; index++) await fail(`person${index}@example.test`, index % 2 ? "::ffff:192.0.2.1" : "192.0.2.1");
  await expect(attempt("fresh@example.test", "192.0.2.1")).rejects.toMatchObject({ code: "rate_limited" });
  await expect(attempt("fresh@example.test", "::ffff:c000:201")).rejects.toMatchObject({ code: "rate_limited" });
  await expect(attempt("fresh@example.test", "192.0.2.2", allowed)).resolves.toBe("signed in");
});

