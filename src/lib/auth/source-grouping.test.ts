import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { accountViewPrefs, setAccountViewPrefs } from "@/lib/metadata/account-preferences";
import { GET, PATCH } from "@/app/api/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken } from "./credentials";
import { inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";

/**
 * How the SQL console's source list groups datasets: by person, the default,
 * or by project. One account's choice, stored with its other list
 * preferences, read and written through the settings operations and their
 * tools, and never seen by another account on the same browser.
 */
let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
const password = "field notebooks at dawn";
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const invite = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(invite.secret, password, db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const origin = "http://instance.test";
function request(secret: string, body?: unknown, kind: "cookie" | "token" = "cookie") {
  const headers: Record<string, string> = kind === "cookie" ? { cookie: `dezfil_session=${secret}` } : { authorization: `Bearer ${secret}` };
  if (body !== undefined) Object.assign(headers, { origin, "content-type": "application/json" });
  return socketRequest(new Request(`${origin}/api/settings`, { method: body === undefined ? "GET" : "PATCH", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function read(secret: string, kind: "cookie" | "token" = "cookie") {
  const response = await GET(request(secret, undefined, kind));
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
async function patch(secret: string, body: unknown, kind: "cookie" | "token" = "cookie") {
  const response = await PATCH(request(secret, body, kind));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const preferences = () => db.prepare("SELECT account_id, view_prefs FROM account_preferences ORDER BY 1").all();

describe("the source-list grouping preference", () => {
  it("reads person by default, persists project, and goes back to person", async () => {
    expect((await read(member.secret)).sourceGrouping).toBe("person");
    const saved = await patch(member.secret, { sourceGrouping: "project" });
    expect(saved.status).toBe(200);
    expect(saved.body.sourceGrouping).toBe("project");
    expect((await read(member.secret)).sourceGrouping).toBe("project");
    expect((await patch(member.secret, { sourceGrouping: "person" })).body.sourceGrouping).toBe("person");
    expect((await read(member.secret)).sourceGrouping).toBe("person");
  });

  it("never shows one account's choice to another, on the same browser or on a token", async () => {
    await patch(member.secret, { sourceGrouping: "project" });
    // The browser switches account: the next account reads only its own.
    expect((await read(admin.secret)).sourceGrouping).toBe("person");
    const adminToken = createApiToken(authenticateSession(admin.secret, db)!, "Grouping", db).secret;
    expect((await read(adminToken, "token")).sourceGrouping).toBe("person");
    await patch(adminToken, { sourceGrouping: "project" }, "token");
    await patch(member.secret, { sourceGrouping: "person" });
    expect((await read(admin.secret)).sourceGrouping).toBe("project");
    expect((await read(member.secret)).sourceGrouping).toBe("person");
  });

  it("keeps the four list preferences and the grouping apart, each patch leaving the other as it was", async () => {
    await patch(member.secret, { viewPrefs: { maps: { view: "list", sort: "name" } } });
    await patch(member.secret, { sourceGrouping: "project" });
    await patch(member.secret, { viewPrefs: { projects: { sort: "largest" } } });
    const settings = await read(member.secret);
    expect(settings.viewPrefs).toEqual({ maps: { view: "list", sort: "name" }, projects: { sort: "largest" } });
    expect(settings.sourceGrouping).toBe("project");
    expect(accountViewPrefs(member.account.id, db)).toEqual({ maps: { view: "list", sort: "name" }, projects: { sort: "largest" } });
    // Replacing the view preferences whole, as first-account adoption does,
    // keeps the grouping.
    setAccountViewPrefs(member.account.id, { data: { view: "grid" } }, db);
    expect(await read(member.secret)).toMatchObject({ viewPrefs: { data: { view: "grid" } }, sourceGrouping: "project" });
  });

  it("refuses any other value, alone or beside valid fields, before writing anything", async () => {
    const before = preferences();
    for (const value of ["persons", "Project", "", null, 1, ["project"]]) {
      const refused = await patch(member.secret, { displayName: "Changed", sourceGrouping: value });
      expect(refused.status, JSON.stringify(value)).toBe(400);
      expect(refused.body).toEqual({ error: { code: "invalid_request", message: '"sourceGrouping" must be "person" or "project".' } });
    }
    expect(preferences()).toEqual(before);
    expect((await read(member.secret)).displayName).toBe("Member");
  });
});

describe("the grouping through the generated tools", () => {
  it("reads and writes it with get_settings and update_settings, whose schemas name both values", async () => {
    const tools = new Map(buildTools().map(tool => [tool.name, tool]));
    const update = tools.get("update_settings")!;
    const get = tools.get("get_settings")!;
    expect((update.inputSchema.properties as Record<string, { enum?: string[] }>).sourceGrouping.enum).toEqual(["person", "project"]);
    expect(JSON.stringify(get.outputSchema)).toContain('"sourceGrouping"');
    const token = createApiToken(authenticateSession(member.secret, db)!, "Tools", db).secret;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new Request(input, init);
      const headers = new Headers(target.headers);
      headers.set("authorization", `Bearer ${token}`);
      const forwarded = socketRequest(new Request(target, { headers }));
      return target.method === "PATCH" ? PATCH(forwarded) : GET(forwarded);
    }) as typeof fetch;
    const written = await executeTool(update, { sourceGrouping: "project" }, origin, fetchImpl);
    expect(written.ok).toBe(true);
    const settings = await executeTool(get, {}, origin, fetchImpl);
    expect(settings.ok).toBe(true);
    expect(JSON.stringify(settings.body)).toContain('"sourceGrouping":"project"');
    expect((await read(admin.secret)).sourceGrouping).toBe("person");
  });
});
