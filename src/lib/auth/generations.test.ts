import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { adoptDoorGeneration, readGenerations, raiseSignOutGeneration } from "@/lib/metadata/auth-generations";
import { createFirstAccount, signIn } from "./accounts";
import { authenticateSession, authenticateToken, createApiToken, requireCurrentActor } from "./credentials";
import { inviteAccount, issueSignInLink } from "./admin";
import { redeemSignInLink } from "./links";
import { delegateCredential } from "./delegation";
import { gateRequest } from "./gate";
import { SESSION_COOKIE } from "./http";
import { currentSession } from "./entry";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
const password = "folded maps beside the river";
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "generations-")); closeMetadataDb(); vi.stubEnv("DEZFIL_DATA_DIR", directory); });
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const read = (secret: string) => currentSession(socketRequest(new Request("https://instance.test/api/auth/session", { headers: { authorization: `Bearer ${secret}` } })));
it.each([true, false])("invalidates both parents in both raise orderings (sign-out first: %s), while every fresh mint works", async signOutFirst => {
  const db = metadataDb();
  const first = await createFirstAccount({ name: "Owner", email: "owner@example.test", password }, db);
  const context = authenticateSession(first.secret, db)!;
  const invited = inviteAccount(context, { name: "Member", email: "member@example.test" }, db);
  const member = await redeemSignInLink(invited.secret!, password, db);
  db.prepare("UPDATE accounts SET external_identity='bound-member',is_admin=1 WHERE id=?").run(member.account.id);
  db.prepare("INSERT INTO projects(id,name,owner_id,created_at,updated_at) VALUES('project','Shared',?,'time','time')").run(first.account.id);
  db.prepare("INSERT INTO project_people(project_id,account_id,role,added_at) VALUES('project',?,'editor','time')").run(member.account.id);
  const memberships = db.prepare("SELECT * FROM project_people").all();
  const accountsBefore = db.prepare("SELECT * FROM accounts ORDER BY id").all();
  let sessions = [first, member];
  for (const kind of signOutFirst ? ["sign-out", "door"] : ["door", "sign-out"]) {
    const contexts = sessions.map(session => authenticateSession(session.secret, db)!);
    const tokens = contexts.map(c => createApiToken(c, "Token", db));
    const tokenContexts = tokens.map(token => authenticateToken(token.secret, db)!);
    const delegations = contexts.flatMap((c, index) => [delegateCredential(c, db), delegateCredential(authenticateToken(tokens[index].secret, db)!, db)]);
    db.transaction(() => kind === "sign-out" ? raiseSignOutGeneration(db) : adoptDoorGeneration(4, db)).immediate();
    for (const session of sessions) expect(authenticateSession(session.secret, db)).toBeNull();
    for (const token of tokens) expect(() => authenticateToken(token.secret, db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
    for (const c of tokenContexts) expect(() => requireCurrentActor(c, db)).toThrow(expect.objectContaining({ code: "token_outdated" }));
    const gated = gateRequest(socketRequest(new Request("https://instance.test/maps", { headers: { cookie: `${SESSION_COOKIE}=${sessions[0].secret}` } })));
    expect(gated.headers.get("location")).toBe("https://instance.test/sign-in");
    expect(db.prepare("SELECT * FROM project_people").all()).toEqual(memberships);
    for (const c of contexts) expect(() => requireCurrentActor(c, db)).toThrow(expect.objectContaining({ code: "authentication_required" }));
    for (const delegation of delegations) expect((await read(delegation)).status).toBe(401);
    // Password, link and token creation each take both current stamps.
    const owner = await signIn("owner@example.test", password, db);
    const link = issueSignInLink(authenticateSession(owner.secret, db)!, member.account.id, db);
    const freshMember = await redeemSignInLink(link.secret, password, db);
    sessions = [owner, freshMember];
    for (const session of sessions) {
      const fresh = authenticateSession(session.secret, db)!; expect(fresh).not.toBeNull();
      const token = createApiToken(fresh, "After raise", db); expect(authenticateToken(token.secret, db)).not.toBeNull();
      expect((await read(delegateCredential(fresh, db))).status).toBe(200);
      expect((await read(delegateCredential(authenticateToken(token.secret, db)!, db))).status).toBe(200);
    }
    const current = readGenerations(db);
    for (const table of ["auth_sessions", "auth_tokens"]) expect(db.prepare(`SELECT sign_out_generation,door_generation FROM ${table} ORDER BY rowid DESC LIMIT 1`).get()).toEqual(current);
  }
  const identity = (rows: unknown[]) => rows.map(row => { const { id, is_admin, external_identity, sql_name } = row as Record<string, unknown>; return { id, is_admin, external_identity, sql_name }; });
  expect(identity(db.prepare("SELECT * FROM accounts ORDER BY id").all())).toEqual(identity(accountsBefore));
});
