import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { getAccount, insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { writeStoredSettings } from "@/lib/settings/store";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createApiToken, authenticateSession, issueSession, secretHash } from "./credentials";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./passwords";
import { withLoginLimit } from "./login-limits";
import { AuthError } from "./errors";
import { enter } from "./entry";
import { PASSWORD_CHECK_WINDOW_MS } from "./password-check-limits";
import { PATCH as profile } from "@/app/api/account/route";
import { POST as passwordChange } from "@/app/api/account/password/route";

/** Password work completes at once unless held. The stored hash is the dummy
 * one, whose key is all zeros: "correct" derives zeros and so verifies, any
 * other password derives ones and does not. */
const native = vi.hoisted(() => {
  const state = {
    hold: false, failNext: false,
    calls: [] as { password: string; done: boolean; callback: (error: Error | null, key: Buffer) => void }[],
    settle(call: { password: string; done: boolean; callback: (error: Error | null, key: Buffer) => void }, error: Error | null = null) {
      if (call.done) return; call.done = true;
      call.callback(error, Buffer.alloc(32, call.password === "correct" ? 0 : 1));
    },
  };
  return state;
});
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  scrypt: (password: string, _salt: Buffer, _length: number, _options: unknown, callback: (error: Error | null, key: Buffer) => void) => {
    const call = { password, callback, done: false }; native.calls.push(call);
    if (native.failNext) { native.failNext = false; queueMicrotask(() => native.settle(call, new Error("native failure"))); }
    else if (!native.hold) queueMicrotask(() => native.settle(call));
  },
}));

const now = 1_800_000_000_000, origin = "http://instance.test";
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let db: Database, directory: string, sessions: string[], token: string;
const pending: Promise<unknown>[] = [];
const track = <T>(p: Promise<T>) => { pending.push(p); p.catch(() => {}); return p; };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); native.calls.length = 0; native.hold = false; native.failNext = false;
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "password-checks-"));
  db = metadata.open(path.join(directory, "metadata.sqlite")); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const account = insertAccount({ id: "person", name: "Person", email: "person@example.test", passwordHash: DUMMY_PASSWORD_HASH, isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
  markOriginalAccount(account.id, db);
  insertAccount({ id: "other", name: "Other", email: "other@example.test", passwordHash: DUMMY_PASSWORD_HASH, isAdmin: false, status: "active", now: new Date(now).toISOString() }, db);
  sessions = [0, 1].map(() => `dezfil_session=${issueSession(account, db, now).secret}`);
  token = createApiToken(authenticateSession(sessions[0].split("=")[1], db)!, "Checks", db).secret;
});
afterEach(async () => {
  native.hold = false; for (const call of native.calls) native.settle(call); await flush();
  await Promise.allSettled(pending); pending.length = 0;
  vi.restoreAllMocks(); vi.useRealTimers(); db.close(); rmSync(directory, { recursive: true, force: true });
});

type Credential = { cookie: string } | { bearer: string };
function req(url: string, body: unknown, credential: Credential, method = "POST", signal?: AbortSignal) {
  const auth: Record<string, string> = "cookie" in credential ? { cookie: credential.cookie } : { authorization: `Bearer ${credential.bearer}` };
  return socketRequest(new Request(origin + url, { method, signal, headers: { origin, "content-type": "application/json", ...auth },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
}
const session = (index = 0): Credential => ({ cookie: sessions[index] });
/** A password change or an email change, each with its own current password. */
function check(kind: "password" | "email", currentPassword: string | undefined, credential = session(), signal?: AbortSignal) {
  if (kind === "password") return track(passwordChange(req("/api/account/password", { currentPassword, password: "new field notebooks" }, credential, "POST", signal)));
  return track(profile(req("/api/account", { email: "person@example.test", ...(currentPassword === undefined ? {} : { currentPassword }) }, credential, "PATCH", signal)));
}
async function answer(response: Promise<Response>) {
  const settled = await response;
  return { status: settled.status, code: settled.status === 499 ? null : ((await settled.json()) as { error?: { code: string } }).error?.code ?? null };
}
const allowance = () => db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = 'check:person'").get() as { failures: number; pending: number } | undefined;
const signInBucket = () => db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`account:${secretHash("person@example.test")}`);
const wrong = { status: 403, code: "current_password_required" }, limited = { status: 429, code: "rate_limited" };

describe("current-password checks share one allowance per account", () => {
  it("pauses every check after the default five failures, across both actions, sessions and a token, without password work", async () => {
    const credentials = [session(0), session(1), { bearer: token }, session(1), session(0)];
    for (const [index, credential] of credentials.entries()) expect(await answer(check(index % 2 ? "email" : "password", "wrong", credential))).toEqual(wrong);
    expect(allowance()).toEqual({ failures: 5, pending: 0 });
    const work = native.calls.length;
    for (const kind of ["password", "email"] as const) {
      const response = await check(kind, "correct", session(1));
      expect(response.status).toBe(429);
      const body = await response.json() as { error: { code: string; message: string; retryAfter: number; retryAt: string } };
      expect(body.error).toEqual({ code: "rate_limited", message: "Too many wrong current passwords. Try again later.",
        retryAfter: PASSWORD_CHECK_WINDOW_MS / 1000, retryAt: new Date(now + PASSWORD_CHECK_WINDOW_MS).toISOString() });
      expect(response.headers.get("retry-after")).toBe(String(PASSWORD_CHECK_WINDOW_MS / 1000));
    }
    expect(native.calls).toHaveLength(work);
    // Another account's checks are its own.
    const other = `dezfil_session=${issueSession(getAccount("other", db)!, db, now).secret}`;
    expect(await answer(check("password", "correct", { cookie: other }))).toEqual({ status: 200, code: null });
  });

  it("admits the check that reaches the threshold and refuses the next, at a changed threshold", async () => {
    writeStoredSettings({ "security.failedPerAccount": 3 }, db);
    expect(await answer(check("email", "wrong"))).toEqual(wrong);
    expect(await answer(check("password", "wrong"))).toEqual(wrong);
    expect(await answer(check("email", "wrong"))).toEqual(wrong);
    expect(await answer(check("password", "correct"))).toEqual(limited);
    // A raised count applies to the very next check, with no restart.
    writeStoredSettings({ "security.failedPerAccount": 4 }, db);
    expect(await answer(check("password", "wrong"))).toEqual(wrong);
    expect(await answer(check("password", "correct"))).toEqual(limited);
  });

  it("returns the allowance when the fixed window expires", async () => {
    for (let i = 0; i < 5; i++) await answer(check("password", "wrong"));
    vi.setSystemTime(now + PASSWORD_CHECK_WINDOW_MS - 1);
    expect(await answer(check("password", "correct"))).toEqual(limited);
    vi.setSystemTime(now + PASSWORD_CHECK_WINDOW_MS);
    expect(await answer(check("password", "correct"))).toEqual({ status: 200, code: null });
  });

  it("never lets concurrent checks exceed what is left", async () => {
    writeStoredSettings({ "security.failedPerAccount": 3 }, db);
    expect(await answer(check("password", "wrong"))).toEqual(wrong);
    native.hold = true;
    const running = [check("password", "wrong", session(0)), check("email", "wrong", session(1))];
    await flush();
    // Two left, two outstanding: the third is refused before it waits for password work.
    const third = check("password", "correct", { bearer: token }); await flush();
    expect(allowance()).toEqual({ failures: 1, pending: 2 });
    expect(native.calls.map(call => call.password)).toEqual(["wrong", "wrong"]);
    native.hold = false; for (const call of native.calls) native.settle(call); await flush();
    expect(await answer(third)).toEqual(limited);
    for (const response of running) expect(await answer(response)).toEqual(wrong);
    expect(allowance()).toEqual({ failures: 3, pending: 0 });
  });

  it("clears its failures on a right password without touching sign-in accounting, and the reverse", async () => {
    for (let i = 0; i < 3; i++) await withLoginLimit("person@example.test", `192.0.2.${i + 1}`, async () => { throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401); }, db).catch(() => {});
    for (let i = 0; i < 4; i++) expect(await answer(check("email", "wrong"))).toEqual(wrong);
    // Sign-in failures did not charge the checks, nor the checks sign-in.
    expect(allowance()).toEqual({ failures: 4, pending: 0 });
    expect(signInBucket()).toEqual({ failures: 3, pending: 0 });
    expect(await answer(check("email", "correct"))).toEqual({ status: 200, code: null });
    expect(allowance()).toEqual({ failures: 0, pending: 0 });
    expect(signInBucket()).toEqual({ failures: 3, pending: 0 });
    for (let i = 0; i < 2; i++) expect(await answer(check("password", "wrong"))).toEqual(wrong);
    const signedIn = await enter(socketRequest(new Request(origin + "/api/auth/sign-in", { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.test", password: "correct" }) }), "192.0.2.1"), "sign-in");
    expect(signedIn.status).toBe(200);
    expect(signInBucket()).toEqual({ failures: 0, pending: 0 });
    expect(allowance()).toEqual({ failures: 2, pending: 0 });
  });
});

describe("what a check counts", () => {
  it("validates the request first: malformed and incomplete requests count nothing and do no password work", async () => {
    const malformed = [
      passwordChange(req("/api/account/password", { currentPassword: "wrong" }, session())),
      passwordChange(req("/api/account/password", "{not json", session())),
      passwordChange(req("/api/account/password", { currentPassword: 1, password: "new field notebooks" }, session())),
      profile(req("/api/account", { email: "person@example.test", currentPassword: "wrong", role: "admin" }, session(), "PATCH")),
    ];
    for (const response of malformed) expect(await answer(response)).toEqual({ status: 400, code: "invalid_request" });
    expect(allowance()).toBeUndefined(); expect(native.calls).toHaveLength(0);
  });

  it("counts an omitted current password on an email change as a failed check", async () => {
    expect(await answer(check("email", undefined))).toEqual(wrong);
    expect(allowance()).toEqual({ failures: 1, pending: 0 });
  });

  it("counts a busy refusal and failing password work as nothing", async () => {
    native.hold = true;
    const blockers = Array.from({ length: 3 }, () => track(verifyPassword("hold", DUMMY_PASSWORD_HASH, { class: "protected" })));
    await flush();
    expect(await answer(check("password", "wrong"))).toEqual({ status: 503, code: "authentication_busy" });
    expect(allowance()).toEqual({ failures: 0, pending: 0 });
    native.hold = false; for (const call of native.calls) native.settle(call); await Promise.all(blockers);
    vi.spyOn(console, "error").mockImplementation(() => {});
    native.failNext = true;
    expect((await check("email", "wrong")).status).toBe(500);
    expect(allowance()).toEqual({ failures: 0, pending: 0 });
  });

  it("counts nothing for a caller who leaves before the check starts", async () => {
    native.hold = true;
    const blocker = track(verifyPassword("hold", DUMMY_PASSWORD_HASH, { class: "protected" })); await flush();
    const abort = new AbortController();
    const queued = check("password", "wrong", session(), abort.signal); await flush();
    expect(allowance()).toEqual({ failures: 0, pending: 1 });
    abort.abort(); await flush();
    expect((await queued).status).toBe(499);
    expect(allowance()).toEqual({ failures: 0, pending: 0 });
    native.hold = false; native.settle(native.calls[0]); await blocker;
  });

  it("keeps a started check's place taken for the window when its caller leaves, counting no failure", async () => {
    writeStoredSettings({ "security.failedPerAccount": 3 }, db);
    native.hold = true;
    const aborts = [new AbortController(), new AbortController()];
    for (const abort of aborts) {
      const started = check("password", "correct", session(), abort.signal); await flush();
      expect(native.calls.at(-1)?.password).toBe("correct");
      abort.abort(); await flush(); native.settle(native.calls.at(-1)!); await flush();
      expect((await started).status).toBe(499);
    }
    expect(allowance()).toEqual({ failures: 0, pending: 2 });
    native.hold = false;
    expect(await answer(check("password", "wrong"))).toEqual(wrong);
    expect(await answer(check("password", "correct"))).toEqual(limited);
    vi.setSystemTime(now + PASSWORD_CHECK_WINDOW_MS);
    expect(await answer(check("password", "correct"))).toEqual({ status: 200, code: null });
  });
});
