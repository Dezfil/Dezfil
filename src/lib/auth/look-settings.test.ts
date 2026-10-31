import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { accountLook, accountViewPrefs, setAccountViewPrefs } from "@/lib/metadata/account-preferences";
import { GET, PATCH } from "@/app/api/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken } from "./credentials";
import { inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";

/**
 * The look: its picks, kept with one account, read and written through the
 * settings operations and their tools, beside the view preferences and the
 * grouping in the same document, and never seen by another account.
 */
let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
const password = "field notebooks at dawn";
const TODAY = {
  color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass",
  transparency: "clear",
};
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const invite = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(invite.secret!, password, db);
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
const document = (accountId: string) => {
  const row = db.prepare("SELECT view_prefs FROM account_preferences WHERE account_id = ?").get(accountId) as { view_prefs: string } | undefined;
  return row ? JSON.parse(row.view_prefs) as Record<string, unknown> : undefined;
};

describe("one account's look", () => {
  it("is never read by another account, by cookie or by token, and one account's write leaves the other's alone", async () => {
    const memberToken = createApiToken(authenticateSession(member.secret, db)!, "Look", db).secret;
    const adminToken = createApiToken(authenticateSession(admin.secret, db)!, "Look", db).secret;
    expect((await patch(member.secret, { look: { color: "heather", rail: "open" } })).status).toBe(200);
    // The browser switches account: the next account reads only its own.
    expect((await read(admin.secret)).look).toEqual(TODAY);
    expect((await read(adminToken, "token")).look).toEqual(TODAY);
    expect((await patch(adminToken, { look: { color: "slate", corners: "soft" } }, "token")).status).toBe(200);
    expect((await read(member.secret)).look).toEqual({ ...TODAY, color: "heather", rail: "open" });
    expect((await read(memberToken, "token")).look).toEqual({ ...TODAY, color: "heather", rail: "open" });
    expect((await read(admin.secret)).look).toEqual({ ...TODAY, color: "slate", corners: "soft" });
    expect(document(member.account.id)).toEqual({ look: { color: "heather", rail: "open" } });
    expect(document(admin.account.id)).toEqual({ look: { color: "slate", corners: "soft" } });
  });

  it("sits beside the view preferences and the grouping, each write leaving the others as they were", async () => {
    await patch(member.secret, { viewPrefs: { maps: { view: "list" } } });
    await patch(member.secret, { look: { background: "graticule" } });
    await patch(member.secret, { sourceGrouping: "project" });
    await patch(member.secret, { viewPrefs: { data: { sort: "rows" } } });
    const settings = await read(member.secret);
    expect(settings.viewPrefs).toEqual({ maps: { view: "list" }, data: { sort: "rows" } });
    expect(settings.sourceGrouping).toBe("project");
    expect(settings.look).toEqual({ ...TODAY, background: "graticule" });
    expect(accountViewPrefs(member.account.id, db)).toEqual({ maps: { view: "list" }, data: { sort: "rows" } });
    // Replacing the view preferences whole, as first-account adoption does,
    // keeps the look and the grouping.
    setAccountViewPrefs(member.account.id, { projects: { view: "grid" } }, db);
    expect(await read(member.secret)).toMatchObject({ viewPrefs: { projects: { view: "grid" } }, sourceGrouping: "project",
      look: { ...TODAY, background: "graticule" } });
  });

  it("reads a kept value the version no longer offers as its default and rewrites it only when the person picks", async () => {
    db.prepare("INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, 'kept')")
      .run(member.account.id, JSON.stringify({ look: { color: "teal", density: "compact" } }));
    expect((await read(member.secret)).look).toEqual(TODAY);
    expect(document(member.account.id)).toEqual({ look: { color: "teal", density: "compact" } });
    await patch(member.secret, { look: { corners: "soft" } });
    expect(document(member.account.id)).toEqual({ look: { color: "teal", density: "compact", corners: "soft" } });
    expect(accountLook(member.account.id, db)).toEqual({ ...TODAY, corners: "soft" });
    await patch(member.secret, { look: { color: "harbor" } });
    expect(document(member.account.id)).toEqual({ look: { color: "harbor", density: "compact", corners: "soft" } });
  });

  it("reads the same eight picks for an account that kept a kind of surface Liquid once reached, and leaves it stored", async () => {
    // Liquid once reached a chosen set of surfaces, each kept with the
    // account. Such a value is no longer read, returned or accepted, and
    // nothing removes it: it stays where an earlier version wrote it.
    db.prepare("INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, 'kept')")
      .run(member.account.id, JSON.stringify({ look: { panels: "liquid", liquidCards: "on", liquidMap: "off" } }));
    expect((await read(member.secret)).look).toEqual({ ...TODAY, panels: "liquid" });
    expect(accountLook(member.account.id, db)).toEqual({ ...TODAY, panels: "liquid" });
    const refused = await patch(member.secret, { look: { liquidCards: "off" } });
    expect(refused.status).toBe(400);
    expect(document(member.account.id)).toEqual({ look: { panels: "liquid", liquidCards: "on", liquidMap: "off" } });
    expect((await patch(member.secret, { look: { panels: "glass" } })).body.look).toEqual(TODAY);
    expect(document(member.account.id)).toEqual({ look: { panels: "glass", liquidCards: "on", liquidMap: "off" } });
  });

  it("writes nothing for an empty slice", async () => {
    expect((await patch(member.secret, { look: {} })).body.look).toEqual(TODAY);
    expect(document(member.account.id)).toBeUndefined();
  });
});

describe("the look through the generated tools", () => {
  const tools = () => new Map(buildTools().map(tool => [tool.name, tool]));
  type Schema = { type?: unknown; enum?: string[]; required?: string[]; additionalProperties?: unknown; properties?: Record<string, Schema> };

  it("names the eight picks, closed, with the catalogue's choices, on the update input and the read output", () => {
    const update = tools().get("update_settings")!, get = tools().get("get_settings")!;
    const input = (update.inputSchema.properties as Record<string, Schema>).look;
    expect(input.additionalProperties).toBe(false);
    expect(input.required).toBeUndefined();
    expect(update.inputSchema.required ?? []).not.toContain("look");
    expect(Object.fromEntries(Object.entries(input.properties!).map(([key, value]) => [key, value.enum]))).toEqual({
      color: ["kelp", "harbor", "heather", "slate"], contrast: ["standard", "more"], font: ["inter", "system"],
      background: ["atlantic", "plain", "graticule", "hex"], corners: ["rounded", "soft"], rail: ["hover", "open", "icons"],
      panels: ["glass", "liquid", "paper"], transparency: ["clear", "medium", "firm"],
    });
    expect(JSON.stringify(get.outputSchema)).toContain('"look"');
  });

  it("refuses an unknown value or key before any call, and reads and writes a pick through the API", async () => {
    const update = tools().get("update_settings")!, get = tools().get("get_settings")!;
    const unused = vi.fn();
    for (const look of [{ color: "teal" }, { glow: "on" }, { rail: null }, { panels: "frosted" }, { transparency: "opaque" }, { liquidCards: "on" }, { liquidChrome: "off" }]) {
      const refused = await executeTool(update, { look }, origin, unused as unknown as typeof fetch);
      expect(refused.ok, JSON.stringify(look)).toBe(false);
    }
    expect(unused).not.toHaveBeenCalled();
    const token = createApiToken(authenticateSession(member.secret, db)!, "Tools", db).secret;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new Request(input, init);
      const headers = new Headers(target.headers);
      headers.set("authorization", `Bearer ${token}`);
      const forwarded = socketRequest(new Request(target, { headers }));
      return target.method === "PATCH" ? PATCH(forwarded) : GET(forwarded);
    }) as typeof fetch;
    expect((await executeTool(update, { look: { color: "harbor", font: "system" } }, origin, fetchImpl)).ok).toBe(true);
    const settings = await executeTool(get, {}, origin, fetchImpl);
    expect(settings.ok).toBe(true);
    expect((settings.body as { look: unknown }).look).toEqual({ ...TODAY, color: "harbor", font: "system" });
    expect((await read(admin.secret)).look).toEqual(TODAY);
  });
});
