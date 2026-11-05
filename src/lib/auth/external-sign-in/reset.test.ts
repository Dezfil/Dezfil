import { copyFileSync } from "node:fs";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { heldResetTurn, resetContender } from "../../../../test-support/door-generation-reset";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getAccountByEmail } from "@/lib/metadata/accounts";
import { readGenerations } from "@/lib/metadata/auth-generations";
import { testAccountScope } from "@/lib/test-support/accounts";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { POST as resume } from "@/app/api/assistant/messages/route";
import { authenticateSession, authenticateToken, createApiToken, issueSession } from "../credentials";
import { authenticateDelegation, delegateCredential } from "../delegation";
import { accountScope } from "../scope";
import { currentSession } from "../entry";
import { SESSION_COOKIE } from "../http";
import { initializeAuthGenerations } from "../generations";
import * as signOut from "../sign-out-everyone";
import { arriveExternalSignIn } from "./arrival";

let f: ReturnType<typeof externalFixture>;
beforeEach(() => {
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "");
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "0");
  f = externalFixture(); vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { pendingActions.resetForTests(); assistantRuns.resetForTests(); f.close(); });
const reset = (value: number, floor = 0) => ({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET: String(value), DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR: String(floor) });
const records = () => f.db.prepare("SELECT value,applied_at FROM auth_door_generation_resets ORDER BY rowid").all();
function credentials(email = "owner@example.test") {
  const session = issueSession(getAccountByEmail(email, f.db)!, f.db, Date.now()).secret;
  const context = authenticateSession(session, f.db)!;
  const token = createApiToken(context, "Recovery test", f.db).secret;
  const tokenContext = authenticateToken(token, f.db)!;
  return { session, context, token, child: createApiToken(tokenContext, "Child", f.db).secret,
    sessionDelegation: delegateCredential(context, f.db), tokenDelegation: delegateCredential(tokenContext, f.db) };
}
function works(c: ReturnType<typeof credentials>) {
  expect(authenticateSession(c.session, f.db)).not.toBeNull();
  for (const token of [c.token, c.child]) expect(authenticateToken(token, f.db)).not.toBeNull();
  for (const delegated of [c.sessionDelegation, c.tokenDelegation]) expect(authenticateDelegation(delegated, f.db)).not.toBeNull();
}
function ended(c: ReturnType<typeof credentials>) {
  expect(authenticateSession(c.session, f.db)).toBeNull();
  expect(authenticateDelegation(c.sessionDelegation, f.db)).toBeNull();
  for (const token of [c.token, c.child]) expect(() => authenticateToken(token, f.db)).toThrow(expect.objectContaining({ code: "token_outdated",
    message: "This token was made before everyone was signed out and no longer works. Create a new one." }));
  expect(() => authenticateDelegation(c.tokenDelegation, f.db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
}
async function owner() { expect((await arriveExternalSignIn(f.request())).status).toBe(200); return credentials(); }
function signedWith(key: KeyObject, generation: number) {
  const presentation = f.ticket({ door_generation: generation });
  const payload = presentation.encoded.split(".").slice(0, 2).join(".");
  return { ...presentation, encoded: `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}` };
}

it("recovers from a hostile maximum in one restart and refuses a fresh ticket from the removed key", async () => {
  const original = await owner(); works(original);
  testAccountScope(f.db, "intruder");
  expect((await arriveExternalSignIn(f.request(f.ticket({ sub: "intruder-id", email: "intruder@example.test", door_generation: Number.MAX_SAFE_INTEGER })))).status).toBe(200);
  ended(original); const hostile = credentials("intruder@example.test"); works(hostile);
  const newKeys = generateKeyPairSync("ed25519");
  const oldKey = process.env.DEZFIL_EXTERNAL_SIGN_IN_KEYS!;
  f.restart();
  expect(f.start({ ...reset(7, 7), DEZFIL_EXTERNAL_SIGN_IN_KEYS: newKeys.publicKey.export({ format: "jwk" }).x! })).toBe(true);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 7 });
  ended(original); ended(hostile);
  const refused = await currentSession(socketRequest(new Request("https://instance.test/api/auth/session", { headers: { cookie: `${SESSION_COOKIE}=${hostile.session}` } })));
  expect(refused.status).toBe(401); expect(await refused.json()).toMatchObject({ error: { code: "authentication_required", message: "Sign in to continue." } });
  expect(console.info).toHaveBeenCalledExactlyOnceWith("[auth] Door generation reset to 7; every session and token ended.");
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(oldKey);
  const legitimate = await arriveExternalSignIn(f.request(signedWith(newKeys.privateKey, 7)));
  expect(legitimate.status).toBe(200);
  const cookie = legitimate.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))!;
  expect(authenticateSession(cookie.split(";")[0].slice(SESSION_COOKIE.length + 1), f.db)).not.toBeNull();
  const beforeLow = f.snapshot();
  expect((await arriveExternalSignIn(f.request(signedWith(newKeys.privateKey, 6)))).status).toBe(401);
  expect(f.snapshot()).toEqual(beforeLow);
  const fresh = credentials(); works(fresh);
  const beforeRetry = f.snapshot(); vi.mocked(console.info).mockClear();
  f.restart(); expect(f.start()).toBe(false); expect(f.snapshot()).toEqual(beforeRetry); works(fresh);
  const applied = records()[0] as { applied_at: string };
  expect(console.info).toHaveBeenCalledExactlyOnceWith(`[auth] Door generation reset 7 was already applied at ${applied.applied_at}; choose a new value to reset again.`);
  // A fresh browser start and unused id make the verifier the only refusal.
  const removed = f.ticket({ door_generation: Number.MAX_SAFE_INTEGER });
  expect(f.db.prepare("SELECT 1 FROM auth_ticket_ids WHERE id=?").get(removed.claims.jti)).toBeUndefined();
  const beforeRemoved = f.snapshot();
  expect((await arriveExternalSignIn(f.request(removed))).status).toBe(401);
  expect(f.snapshot()).toEqual(beforeRemoved);
  f.start({ DEZFIL_EXTERNAL_SIGN_IN_KEYS: `${newKeys.publicKey.export({ format: "jwk" }).x},${oldKey}` });
  expect((await arriveExternalSignIn(f.request(removed))).status).toBe(200);
});

it("ends live delegations, token descendants, running work and a park without replacing process state", async () => {
  await owner(); testAccountScope(f.db, "intruder");
  expect((await arriveExternalSignIn(f.request(f.ticket({ sub: "intruder-id", email: "intruder@example.test", door_generation: Number.MAX_SAFE_INTEGER })))).status).toBe(200);
  const hostile = credentials("intruder@example.test"); works(hostile);
  const scope = accountScope(hostile.context, f.db), running = heldResetTurn(scope);
  await running.entered;
  const parkId = assistantRuns.reserve(scope).id; assistantRuns.bind(scope, parkId, {});
  const continued = vi.fn(async () => ({ text: "should not resume", toolCalls: [] })), dispose = vi.fn();
  const pending = pendingActions.park(scope, { runId: parkId, exchange: { send: continued, continueWith: continued, dispose },
    policy: "full", calls: [], index: 0, outcomes: [], steps: 1, headers: {} });
  assistantRuns.record(scope, parkId, { type: "confirm_required", id: pending, tool: "sign_everyone_out", args: {} });
  expect(assistantRuns.read(scope, parkId).state).toBe("awaiting_confirmation");
  const delegationKey = Reflect.get(process, Symbol.for("dezfil.session-delegation-key"));
  try {
    f.start(reset(7));
    ended(hostile);
    expect(Reflect.get(process, Symbol.for("dezfil.session-delegation-key"))).toBe(delegationKey);
    expect(running.signal.aborted).toBe(true); expect(await running.result).toHaveProperty("error");
    expect(assistantRuns.read(scope, running.id).state).toBe("interrupted");
    expect(assistantRuns.read(scope, parkId).state).toBe("interrupted");
    expect(dispose).toHaveBeenCalledOnce();
    const fresh = credentials("intruder@example.test"); works(fresh);
    const response = await resume(socketRequest(new Request("https://instance.test/api/assistant/messages", { method: "POST",
      headers: { origin: "https://instance.test", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${fresh.session}` },
      body: JSON.stringify({ resolution: { pending, approved: true } }) })));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "pending_superseded" } });
    expect(continued).not.toHaveBeenCalled();
    const next = heldResetTurn(accountScope(fresh.context, f.db)); await next.entered; next.release();
    expect(await next.result).toHaveProperty("text", expect.stringContaining("finished")); expect(next.signal.aborted).toBe(false);
  } finally { running.release(); await running.result; await new Promise(resolve => setImmediate(resolve)); }
});

it("an equal reset ends credentials, then a higher floor refuses credentials stamped at the reset value", async () => {
  const old = await owner(); f.start(reset(0)); ended(old);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 0 });
  const equal = credentials(); works(equal);
  f.start(reset(7, 10)); ended(equal);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 2, door_generation: 10 });
  const atReset = credentials();
  f.db.prepare("UPDATE auth_sessions SET door_generation=7 WHERE id=?").run(atReset.context.credential.id);
  expect(authenticateSession(atReset.session, f.db)).toBeNull();
  f.db.prepare("UPDATE auth_tokens SET door_generation=7").run();
  expect(() => authenticateToken(atReset.token, f.db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
  const before = f.snapshot(); expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 7 })))).status).toBe(401);
  expect(f.snapshot()).toEqual(before); works(credentials());
});

it("rolls back both generations and the record on a failure after insert, then applies on the next start", async () => {
  const old = await owner(), before = f.snapshot();
  f.db.exec("CREATE TRIGGER abort_reset AFTER INSERT ON auth_door_generation_resets BEGIN SELECT RAISE(ABORT, 'reset insert failed'); END");
  expect(() => f.start(reset(7))).toThrow("reset insert failed");
  f.restart(); expect(f.snapshot()).toEqual(before); works(old); expect(console.info).not.toHaveBeenCalled();
  f.db.exec("DROP TRIGGER abort_reset"); expect(f.start()).toBe(true); ended(old);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 7 }); expect(records()).toHaveLength(1);
});

it("keeps a committed reset when assistant interruption throws and never repeats it after reopening", async () => {
  const old = await owner();
  vi.spyOn(signOut, "interruptOlderAssistantWork").mockImplementationOnce(() => { throw new Error("after commit"); });
  expect(() => f.start(reset(7))).toThrow("after commit");
  const committed = f.snapshot(); f.restart(); expect(f.snapshot()).toEqual(committed);
  expect(f.start()).toBe(false); expect(f.snapshot()).toEqual(committed); ended(old);
  expect(records()).toHaveLength(1); expect(readGenerations(f.db).sign_out_generation).toBe(1);
});

it("applies 7, 8, 7 twice and losing the durable record makes the same restart apply again", async () => {
  await owner();
  for (const value of [7, 8]) { const old = credentials(); f.restart(); expect(f.start(reset(value))).toBe(true); ended(old); }
  const fresh = credentials(), before = f.snapshot();
  f.restart(); expect(f.start(reset(7))).toBe(false); expect(f.snapshot()).toEqual(before); works(fresh);
  expect(records().map(row => (row as { value: number }).value)).toEqual([7, 8]);
  expect(readGenerations(f.db).sign_out_generation).toBe(2);
  f.db.prepare("DELETE FROM auth_door_generation_resets WHERE value=7").run();
  f.restart(); expect(f.start()).toBe(true); ended(fresh); expect(readGenerations(f.db).sign_out_generation).toBe(3);
});

it("restored files apply exactly the values absent from that backup's history", async () => {
  await owner();
  const copy = (name: string) => { f.db.pragma("wal_checkpoint(TRUNCATE)"); const file = path.join(f.directory, name); copyFileSync(f.db.name, file); return file; };
  const restore = (file: string) => { const target = f.db.name; closeMetadataDb(); copyFileSync(file, target); f.restart(); };
  const before = copy("before.sqlite"); f.start(reset(7)); const afterSnapshot = f.snapshot(), after = copy("after.sqlite");
  f.start(reset(8)); restore(before); expect(f.start(reset(7))).toBe(true);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 7 }); expect(records()).toHaveLength(1);
  restore(after); expect(f.start(reset(7))).toBe(false); expect(f.snapshot()).toEqual(afterSnapshot);
  expect(f.start(reset(9))).toBe(true); expect(readGenerations(f.db)).toEqual({ sign_out_generation: 2, door_generation: 9 });
  expect(records().map(row => (row as { value: number }).value)).toEqual([7, 9]);
});

it("routine tickets, floors and sign-out move on without repeating a reset, while fresh values may raise or lower", async () => {
  await owner(); f.start(reset(7)); const atSeven = credentials();
  expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 10 })))).status).toBe(200); ended(atSeven);
  const raised = credentials(), before = f.snapshot();
  f.restart(); expect(f.start()).toBe(false); expect(f.snapshot()).toEqual(before); works(raised);
  f.restart(); expect(f.start({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR: "12" })).toBe(true); ended(raised);
  const history = records(), fresh = credentials(); signOut.signEveryoneOut(fresh.context, f.db); ended(fresh);
  expect(records()).toEqual(history); expect(readGenerations(f.db)).toEqual({ sign_out_generation: 2, door_generation: 12 });
  for (const value of [15, 3]) {
    const old = credentials(); f.restart(); expect(f.start(reset(value))).toBe(true); ended(old);
    expect(readGenerations(f.db).door_generation).toBe(value);
  }
  expect(records().map(row => (row as { value: number }).value)).toEqual([7, 15, 3]);
  expect(readGenerations(f.db).sign_out_generation).toBe(4);
  const current = credentials(), final = f.snapshot();
  f.restart(); expect(f.start({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR: "1" })).toBe(false); expect(f.snapshot()).toEqual(final); works(current);
  const beforeLow = f.snapshot(); expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 1 })))).status).toBe(401); expect(f.snapshot()).toEqual(beforeLow);
});

it("applies once when three independent processes start together", async () => {
  await owner(); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "7");
  const workers = Array.from({ length: 3 }, () => resetContender());
  try {
    const ready = await Promise.all(workers.map(worker => worker.ready));
    expect(ready.every(worker => worker.ready)).toBe(true); expect(new Set(ready.map(worker => worker.pid)).size).toBe(3);
    expect(records()).toEqual([]); expect(readGenerations(f.db).sign_out_generation).toBe(0);
    workers.forEach(worker => worker.release());
    const results = await Promise.all(workers.map(worker => worker.result));
    expect(results.map(result => result.applied).sort()).toEqual([false, false, true]);
    for (const result of results) expect(result.generations).toEqual({ sign_out_generation: 1, door_generation: 7 });
    expect(results.filter(result => result.logs.some(line => line.includes("already applied")))).toHaveLength(2);
    expect(results.filter(result => result.logs.some(line => line.includes("every session and token ended")))).toHaveLength(1);
    expect(records()).toHaveLength(1);
  } finally { workers.forEach(worker => worker.stop()); await Promise.allSettled(workers.map(worker => worker.result)); }
});

it("works when keys and audience are both removed, and leaves account and personal state unchanged", async () => {
  const old = await owner(); const ownerId = old.context.account.id;
  testAccountScope(f.db, "intruder");
  f.db.prepare("INSERT INTO projects(id,name,owner_id,created_at,updated_at) VALUES('shared','Shared',?,'time','time')").run(ownerId);
  f.db.prepare("INSERT INTO project_people VALUES('shared','intruder','editor','time')").run();
  f.db.prepare("INSERT INTO assistant_keys VALUES(?, 'openai', 'kept-envelope', '1234', 1)").run(ownerId);
  f.db.prepare("UPDATE accounts SET password_hash='kept-password' WHERE id=?").run(ownerId);
  const accountState = () => ["accounts", "project_people", "assistant_keys"].map(t => f.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  const before = accountState(); const intruder = credentials("intruder@example.test");
  f.restart(); expect(f.start({ ...reset(0), DEZFIL_EXTERNAL_SIGN_IN_KEYS: undefined, DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: undefined })).toBe(true);
  ended(old); ended(intruder); expect(accountState()).toEqual(before);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 0 });
  works(credentials("intruder@example.test"));
});

it("leaves a deactivated and demoted owner shut out after recovery", async () => {
  const old = await owner();
  f.db.prepare("UPDATE accounts SET status='deactivated',is_admin=0 WHERE id=?").run(old.context.account.id);
  const accounts = f.db.prepare("SELECT * FROM accounts").all();
  f.restart(); f.start(reset(7));
  expect(f.db.prepare("SELECT * FROM accounts").all()).toEqual(accounts);
  const before = f.snapshot();
  const response = await arriveExternalSignIn(f.request(f.ticket({ door_generation: 7 })));
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: "account_deactivated" } });
  expect(f.snapshot()).toEqual(before);
});

it("unset and empty values leave the store alone, and the start routine reads each reset directly from the environment", async () => {
  const old = await owner(), before = f.snapshot();
  for (const value of [undefined, "", "   "]) {
    expect(f.start({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET: value })).toBe(false); expect(f.snapshot()).toEqual(before);
  }
  works(old); expect(console.info).not.toHaveBeenCalled();
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "0");
  expect(initializeAuthGenerations(f.db)).toBe(true); ended(old);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: 0 });
});
