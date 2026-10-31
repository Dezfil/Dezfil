import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateAgainstSchema } from "@/lib/export/schema-validate";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { arriveExternalSignIn } from "./arrival";
import { authenticateSession, createApiToken, issueSession } from "../credentials";
import { getAccountByEmail } from "@/lib/metadata/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { POST as invite } from "@/app/api/users/route";
import { GET as config } from "@/app/api/config/route";
import { entryInformation } from "../entry";
import { readInstanceSettings } from "@/lib/settings/read";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { testClient } from "@/lib/mcp/test-client";
let f: ReturnType<typeof externalFixture>;
beforeEach(async () => { f = externalFixture(); expect((await arriveExternalSignIn(f.request())).status).toBe(200); });
afterEach(() => { vi.unstubAllGlobals(); f.close(); });
function owner() {
  const session = issueSession(getAccountByEmail("owner@example.test", f.db)!, f.db, Date.now());
  const context = authenticateSession(session.secret, f.db)!;
  return { context, token: createApiToken(context, "Invitation", f.db).secret };
}
const credentials = () => ["auth_links", "auth_sessions", "auth_tokens"].map(table => f.db.prepare(`SELECT id,account_id FROM ${table} ORDER BY id`).all());
it.each([true, false])("invites through the generated tool with external sign-in = %s", async enabled => {
  if (!enabled) {
    vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", ""); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "");
    Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
  }
  const actor = owner(), before = credentials(); let answer: Record<string, unknown> = {};
  const client = await testClient(async request => {
    request.headers.set("authorization", `Bearer ${actor.token}`);
    const response = await invite(socketRequest(request)); expect(response.status).toBe(201);
    answer = await response.clone().json(); return response;
  });
  try {
    const listing = await client.listTools(), tool = listing.tools.find(tool => tool.name === "invite_user")!;
    const result = await client.callTool({ name: "invite_user", arguments: { name: "Invited", email: "invited@example.test" } });
    expect(result.isError).not.toBe(true);
    expect(validateAgainstSchema(result.structuredContent, tool.outputSchema!)).toEqual([]);
    const doc = buildOpenApiDocument();
    expect(validateAgainstSchema(answer, doc.components.schemas.UserInvitation, "$", doc.components.schemas)).toEqual([]);
    expect(answer.account).toMatchObject({ email: "invited@example.test", status: "invited" });
    if (enabled) {
      expect(Object.keys(answer)).toEqual(["account"]); expect(credentials()).toEqual(before);
    } else {
      expect(answer.signInUrl).toMatch(/\/accept#secret=/); expect(answer.expiresAt).toEqual(expect.any(String));
      expect(credentials()[0]).toHaveLength(before[0].length + 1); expect(credentials().slice(1)).toEqual(before.slice(1));
    }
    // Invitations stay outside the sharing directory until their first arrival.
    const { GET: directory } = await import("@/app/api/accounts/search/route");
    const response = await directory(socketRequest(new Request("https://instance.test/api/accounts/search?q=Invited", { headers: { authorization: `Bearer ${actor.token}` } })));
    expect(await response.json()).toEqual({ accounts: [] });
  } finally { await client.close(); }
});
it("reports the frozen mode and address to entry, the mode to configuration, and counts and generations to admins", async () => {
  const actor = owner();
  const request = socketRequest(new Request("https://instance.test/api/auth/entry"));
  const entry = await (await entryInformation(request)).json();
  expect(entry).toMatchObject({ externalSignIn: { enabled: true, doorUrl: "https://door.example/sign-in" }, setupRequired: false });
  const response = await config(socketRequest(new Request("https://instance.test/api/config", { headers: { authorization: `Bearer ${actor.token}` } })));
  expect(await response.json()).toMatchObject({ externalSignIn: { enabled: true } });
  expect(readInstanceSettings(actor.context, f.db).externalSignIn).toEqual({ enabled: true, keyCount: 1, signOutGeneration: 0, doorGeneration: 0 });
  expect(JSON.stringify(entry)).not.toMatch(/owner@example|owner-id|keys/);
  expect(JSON.stringify(readInstanceSettings(actor.context, f.db))).not.toContain(process.env.DEZFIL_EXTERNAL_SIGN_IN_KEYS);
});
