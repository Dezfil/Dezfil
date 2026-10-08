import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, ruleRefusalBody, tokenFor } from "@/lib/test-support/rule-roads";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

/**
 * Who may create API tokens, on every road. Admins only refuses a member a
 * new token and takes nothing away: every token made earlier keeps
 * authenticating, listing and revoking until it is revoked or expires.
 */
const SENTENCE = "Only admins can create tokens on this instance.";
let db: Database;
let tokens: Record<string, string>;

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  // Made while everyone could: what a narrowed rule must leave working.
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function setTokens(value: "everyone" | "admins") {
  const response = await changeInstanceSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ "tokens.create": value }),
  }), db, "admin"));
  expect(response.status).toBe(200);
}
const stored = () => db.prepare("SELECT id, account_id, name, revoked_at, expires_at FROM auth_tokens ORDER BY created_at, id").all();
const names = (body: unknown) => (body as { tokens: { name: string; revokedAt: string | null }[] }).tokens
  .map(token => `${token.name}${token.revokedAt ? " (revoked)" : ""}`).sort();

describe("who may create tokens", () => {
  it.each(ROADS)("under admins, refuses a member a new token by %s, naming the rule, storing nothing", async road => {
    await setTokens("admins");
    const before = stored();
    const answer = await callAs(db, road, "member", tokens.member, "create_api_token", { name: "Another" });
    expect(answer).toEqual({ status: 403, body: ruleRefusalBody("tokens.create", SENTENCE) });
    expect(stored()).toEqual(before);
  });

  it.each(ROADS)("under admins, keeps every token a member made by %s: it authenticates, lists and revokes", async road => {
    tokenFor(db, "member", "Spare");
    await setTokens("admins");
    const listed = await callAs(db, road, "member", tokens.member, "list_api_tokens");
    expect(listed.status).toBe(200);
    expect(names(listed.body)).toEqual(["Roads", "Spare"]);
    const spare = (listed.body as { tokens: { id: string; name: string }[] }).tokens.find(token => token.name === "Spare")!;
    expect((await callAs(db, road, "member", tokens.member, "revoke_api_token", { id: spare.id })).status).toBe(200);
    expect(names((await callAs(db, "token", "member", tokens.member, "list_api_tokens")).body)).toEqual(["Roads", "Spare (revoked)"]);
  });

  it.each(ROADS)("under admins, lets an admin create a token by %s", async road => {
    await setTokens("admins");
    const answer = await callAs(db, road, "admin", tokens.admin, "create_api_token", { name: `Made by ${road}` });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect(db.prepare("SELECT account_id FROM auth_tokens WHERE name = ?").get(`Made by ${road}`)).toEqual({ account_id: "admin" });
  });

  it.each(ROADS)("under everyone, lets a member create a token by %s", async road => {
    await setTokens("admins");
    await setTokens("everyone");
    const answer = await callAs(db, road, "member", tokens.member, "create_api_token", { name: `Made by ${road}` });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  });

  it("refuses at the token service itself, whatever road reaches it", async () => {
    await setTokens("admins");
    const context = requireRequestAuth(testAccountRequest(new Request("http://instance.test/api/account"), db, "member"), db);
    expect(() => createApiToken(context, "Direct", db)).toThrow(expect.objectContaining({
      code: "rule_refused", status: 403, message: SENTENCE, extra: { rule: "tokens.create" },
    }));
  });
});
