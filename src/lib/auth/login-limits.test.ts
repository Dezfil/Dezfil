import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { AuthError } from "./errors";
import { LOGIN_ACCOUNT_LIMIT, LOGIN_SOURCE_LIMIT, LOGIN_WINDOW_MS, signInFromRequest, withLoginLimit } from "./login-limits";

let db: Database;
const time = 1_000_000;
const denied = async () => { throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401); };
const allowed = async () => "signed in";
beforeEach(() => { db = open(":memory:"); });
afterEach(() => db.close());
const attempt = (email: string, source: string, operation: () => Promise<string> = denied, now = time) => withLoginLimit(email, source, operation, db, () => now);
async function fail(email: string, source: string) {
  await expect(attempt(email, source)).rejects.toMatchObject({ code: "invalid_credentials" });
}

it("throttles normalized accounts across changing sources and states exactly when retry is possible", async () => {
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) await fail(" Person@Example.Test ", `192.0.2.${index + 1}`);
  const operation = vi.fn(allowed);
  await expect(attempt("person@example.test", "198.51.100.1", operation)).rejects.toMatchObject({
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
  await expect(attempt("person@example.test", "192.0.2.2", allowed, time + LOGIN_WINDOW_MS - 1))
    .rejects.toMatchObject({ code: "rate_limited", extra: { retryAfter: 1 } });
  expect(await attempt("person@example.test", "192.0.2.2", allowed, time + LOGIN_WINDOW_MS)).toBe("signed in");
});

it("does not let a successful login reset a source's failures against unrelated accounts", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT - 1; index++) await fail(`person${index}@example.test`, "192.0.2.1");
  expect(await attempt("valid@example.test", "192.0.2.1", allowed)).toBe("signed in");
  await fail("next@example.test", "192.0.2.1");
  await expect(attempt("another@example.test", "192.0.2.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
});

it("reserves capacity before asynchronous password work so concurrent attempts cannot bypass a limit", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempts = Array.from({ length: LOGIN_ACCOUNT_LIMIT }, (_, index) =>
    attempt("person@example.test", `192.0.2.${index + 1}`, async () => { await held; return "signed in"; }));
  try {
    await expect(attempt("person@example.test", "198.51.100.1", allowed)).rejects.toMatchObject({ code: "rate_limited" });
  } finally { release(); await Promise.all(attempts); }
});

it("refunds infrastructure failures and successful attempts", async () => {
  for (let index = 0; index < LOGIN_SOURCE_LIMIT + 1; index++) {
    await expect(attempt("person@example.test", "192.0.2.1", async () => { throw new Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
    expect(await attempt("person@example.test", "192.0.2.1", allowed)).toBe("signed in");
  }
});

it("refuses sign-in without the preload rather than falling back to submitted forwarding headers", async () => {
  const request = new Request("http://instance.test/api/auth/sign-in", { headers: {
    "x-forwarded-for": "192.0.2.1", "x-dezfil-ingress": "forged", "x-forwarded-proto": "https",
  } });
  await expect(signInFromRequest(request, "person@example.test", "anything", db)).rejects.toMatchObject({ code: "ingress_unavailable" });
  expect(db.prepare("SELECT * FROM auth_sessions").all()).toEqual([]);
});
