import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { arriveExternalSignIn } from "./arrival";
import { initializeAuthGenerations } from "../generations";
import { authenticateSession, authenticateToken, createApiToken, issueSession } from "../credentials";
import { getAccountByEmail } from "@/lib/metadata/accounts";
import { readGenerations } from "@/lib/metadata/auth-generations";
let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); }); afterEach(() => f.close());
function credentials() {
  const account = getAccountByEmail("owner@example.test", f.db)!;
  const signed = issueSession(account, f.db, Date.now()), context = authenticateSession(signed.secret, f.db)!;
  return { session: signed.secret, token: createApiToken(context, "Token", f.db).secret };
}
it("adopts higher accepted tickets before minting their session, refuses lower tickets, and never changes identities on refusal", async () => {
  expect((await arriveExternalSignIn(f.request())).status).toBe(200); const old = credentials();
  expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 5 })))).status).toBe(200);
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 0, door_generation: 5 });
  expect(authenticateSession(old.session, f.db)).toBeNull(); expect(() => authenticateToken(old.token, f.db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
  expect(f.db.prepare("SELECT door_generation FROM auth_sessions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ door_generation: 5 });
  const before = f.snapshot(); expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 4 })))).status).toBe(401); expect(f.snapshot()).toEqual(before);
  const fresh = credentials(); expect(authenticateSession(fresh.session, f.db)).not.toBeNull(); expect(authenticateToken(fresh.token, f.db)).not.toBeNull();
});
it("applies the floor after a stopped-store restart, before use, and cannot lower it", async () => {
  expect((await arriveExternalSignIn(f.request())).status).toBe(200); const old = credentials();
  f.restart(); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "9"); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
  expect(initializeAuthGenerations(f.db)).toBe(true);
  expect(authenticateSession(old.session, f.db)).toBeNull(); expect(() => authenticateToken(old.token, f.db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
  const before = f.snapshot(); expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 8 })))).status).toBe(401); expect(f.snapshot()).toEqual(before);
  expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 9 })))).status).toBe(200);
  const fresh = credentials(); expect(authenticateSession(fresh.session, f.db)).not.toBeNull();
  f.restart(); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "2"); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
  expect(initializeAuthGenerations(f.db)).toBe(false); expect(readGenerations(f.db).door_generation).toBe(9);
  expect(authenticateToken(fresh.token, f.db)).not.toBeNull();
});
