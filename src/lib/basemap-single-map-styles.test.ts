import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, tokenFor } from "@/lib/test-support/rule-roads";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { builderContext } from "@/components/builder/assistant/builder-context";
import { GET as readConfig } from "@/app/api/config/route";
import { SINGLE_MAP_STYLES_OFF } from "./basemap";
import { createMap, duplicateMap, updateMap } from "./map-service";
import { redoChange, undoChange } from "./map-history";

/**
 * While an admin has turned off style addresses on single maps, a style
 * address the basemap library does not offer is refused when it would newly
 * be put on a map, by every road (session cookie, API token, generated tool,
 * embedded assistant), for members and admins alike, naming the switch and
 * before the server reads it; an address the library offers is taken. The
 * rule looks at what the write or the replay would leave the map on, so an
 * undo or redo that would put a refused address back is refused too, and
 * whatever a map already holds is kept: saved, sent again, duplicated, and
 * cleared by its editor.
 */

// Every style address is a loopback fixture that counts the requests it
// answers; a request sent anywhere else fails its test first.
keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
const SETTING = "basemaps.singleMapStyles";
const REFUSAL = { status: 403, body: { error: { code: "basemap_not_offered", message: SINGLE_MAP_STYLES_OFF, setting: SETTING } } };
const ACTORS = ["member", "admin"] as const;

let db: Database;
let fixture: Server;
let asked: number;
let base: string;
let tokens: Record<string, string>;
/** An address the library does not offer, and one it does once added. */
const pasted = () => `${base}/pasted/style.json`;
const offered = () => `${base}/library/style.json`;

beforeEach(async () => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "");
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  asked = 0;
  fixture = createServer((_req, res) => {
    asked += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 8, sources: {}, layers: [{ id: "background", type: "background" }] }));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
});
afterEach(async () => {
  fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (db.open) db.close();
});

const revision = (id: string) => readDocumentRevision({ kind: "map", id }, db)!.editRevision!;
const addressOf = (id: string) => {
  const row = db.prepare("SELECT custom_basemap FROM maps WHERE id = ?").get(id) as { custom_basemap: string | null };
  return row.custom_basemap ? (JSON.parse(row.custom_basemap) as { url: string }).url : null;
};
const content = () => ["maps", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

/** An admin's call through the shipped route, by session cookie. */
async function asAdmin(method: string, pathname: string, body?: unknown) {
  const response = await dispatchAssistantTestRoute(testAccountRequest(new Request(`${ORIGIN}${pathname}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, "admin"));
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}
const singleMapStyles = (allowed: boolean) => asAdmin("PATCH", "/api/instance/settings", { [SETTING]: allowed });
const addToLibrary = async () => (await asAdmin("POST", "/api/instance/basemaps", { name: "Works grey", url: offered() })) as { id: string };

/** One embedded-assistant turn on the builder of `mapId` that calls `tool` with `args` as `actor`, approving any confirmation. */
async function assistantCall(actor: string, mapId: string, tool: string, args: Record<string, unknown>) {
  const scope = testAccountScope(db, actor);
  const dispatch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("authorization", `Bearer ${tokens[actor]}`);
    return dispatchAssistantTestRoute(new Request(incoming, { headers }));
  }) as typeof fetch;
  const pending = new PendingActionStore();
  const deps = { scope, baseUrl: ORIGIN, pending, fetchImpl: dispatch };
  // The assistant reads the map first, as it must, to learn its edit revision.
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "read", name: "get_map", args: { id: mapId } }] },
    { text: "", toolCalls: [{ id: "paste", name: tool, args }] },
    { text: "Done.", toolCalls: [] },
  ]);
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "Use this style", history: [], context: builderContext(mapId, null, "dark") }, deps)) events.push(event);
  const question = events.find(event => event.type === "confirm_required");
  if (question?.type === "confirm_required") {
    const parked = pending.claim(scope, question.id, "approved")!;
    for await (const event of resumeAssistant(parked, true, deps)) events.push(event);
  }
  const result = events.find(event => event.type === "tool_result" && event.tool === tool);
  if (result?.type !== "tool_result") throw new Error(`expected a result from ${tool}`);
  return result;
}

describe("with style addresses on single maps off", () => {
  it.each(ROADS)("refuses an address the library does not offer by %s, for a member and an admin alike, naming the switch, reading nothing, changing nothing", async road => {
    await singleMapStyles(false);
    for (const actor of ACTORS) {
      const map = createMap(testAccountScope(db, actor), `${actor} by ${road}`).id, before = content();
      for (const customBasemap of [{ url: pasted() }, { url: pasted(), name: "Mine", force: true }]) {
        const answer = await callAs(db, road, actor, tokens[actor], "update_map", { id: map, customBasemap }, revision(map));
        expect(answer, `${actor} ${JSON.stringify(customBasemap)}`).toEqual(REFUSAL);
      }
      expect(content(), actor).toEqual(before);
    }
    expect(asked, "a refused address is never read").toBe(0);
  });

  it("refuses an address the library does not offer when the embedded assistant pastes it, for a member and an admin alike", async () => {
    await singleMapStyles(false);
    for (const actor of ACTORS) {
      const map = createMap(testAccountScope(db, actor), `${actor} by the assistant`).id, before = content();
      const result = await assistantCall(actor, map, "update_map", { id: map, customBasemap: { url: pasted() } });
      expect(result, actor).toMatchObject({ ok: false, body: REFUSAL.body });
      expect(content(), actor).toEqual(before);
    }
    expect(asked).toBe(0);
  });

  it.each(ROADS)("accepts an address the library offers by %s, pasted or taken, and refuses it again once hidden", async road => {
    const { id } = await addToLibrary();
    await singleMapStyles(false);
    for (const actor of ACTORS) {
      const map = createMap(testAccountScope(db, actor), `${actor} by ${road}`).id;
      const pasting = await callAs(db, road, actor, tokens[actor], "update_map", { id: map, customBasemap: { url: offered() } }, revision(map));
      expect(pasting.status, JSON.stringify(pasting.body)).toBe(200);
      expect(addressOf(map)).toBe(offered());
      expect((await callAs(db, road, actor, tokens[actor], "update_map", { id: map, customBasemap: null }, revision(map))).status).toBe(200);
      const taking = await callAs(db, road, actor, tokens[actor], "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map));
      expect(taking.status, JSON.stringify(taking.body)).toBe(200);
      expect(addressOf(map)).toBe(offered());
    }
    await asAdmin("PATCH", `/api/instance/basemaps/${id}`, { offered: false });
    const map = createMap(testAccountScope(db, "member"), `hidden by ${road}`).id;
    expect(await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: offered() } }, revision(map))).toEqual(REFUSAL);
    expect(addressOf(map)).toBeNull();
  });

  it("accepts an address the library offers when the embedded assistant pastes it", async () => {
    await addToLibrary();
    await singleMapStyles(false);
    for (const actor of ACTORS) {
      const map = createMap(testAccountScope(db, actor), `${actor} by the assistant`).id;
      expect(await assistantCall(actor, map, "update_map", { id: map, customBasemap: { url: offered() } }), actor).toMatchObject({ ok: true });
      expect(addressOf(map)).toBe(offered());
    }
  });

  it.each(ROADS)("keeps a map that holds a pasted address: saved, its address sent again, duplicated, then cleared by %s", async road => {
    const member = testAccountScope(db, "member");
    const map = createMap(member, `held by ${road}`).id;
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: pasted(), name: "Mine" } }, revision(map))).status).toBe(200);
    await singleMapStyles(false);
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, name: `saved by ${road}` }, revision(map))).status).toBe(200);
    const again = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: pasted(), name: "Renamed" } }, revision(map));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(addressOf(map)).toBe(pasted());
    const copy = await callAs(db, road, "member", tokens.member, "duplicate_map", { id: map });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(addressOf((copy.body as { id: string }).id)).toBe(pasted());
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: null }, revision(map))).status).toBe(200);
    expect(addressOf(map)).toBeNull();
  });

  it.each(ROADS)("refuses an undo by %s that would put a cleared address back, and the history read says why", async road => {
    const map = createMap(testAccountScope(db, "member"), `undone by ${road}`).id;
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: pasted() } }, revision(map))).status).toBe(200);
    // A rename between, so the clear is a step of its own (two changes of
    // one field a moment apart are one step).
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, name: `renamed by ${road}` }, revision(map))).status).toBe(200);
    await singleMapStyles(false);
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: null }, revision(map))).status).toBe(200);
    const before = content();
    const history = await callAs(db, road, "member", tokens.member, "get_history", { id: map });
    expect((history.body as { undoTarget: unknown }).undoTarget).toMatchObject({ eligible: false, reason: SINGLE_MAP_STYLES_OFF });
    expect(await callAs(db, road, "member", tokens.member, "undo_change", { id: map }, revision(map))).toEqual(REFUSAL);
    expect(content()).toEqual(before);
    expect(addressOf(map)).toBeNull();
    // Allowed again, the same undo puts it back.
    await singleMapStyles(true);
    expect((await callAs(db, road, "member", tokens.member, "undo_change", { id: map }, revision(map))).status).toBe(200);
    expect(addressOf(map)).toBe(pasted());
  });

  it("refuses an admin's undo that would put an address back, and a redo; an undo taking one away is kept", async () => {
    const admin = testAccountScope(db, "admin"), map = createMap(admin, "redone").id;
    updateMap(admin, map, { customBasemap: { url: pasted(), name: null, attribution: [] } }, { expectedRevision: revision(map) });
    await undoChange(admin, map, { expectedRevision: revision(map) });
    expect(addressOf(map)).toBeNull();
    await singleMapStyles(false);
    expect(await callAs(db, "token", "admin", tokens.admin, "redo_change", { id: map }, revision(map))).toEqual(REFUSAL);
    expect(addressOf(map)).toBeNull();
    await singleMapStyles(true);
    await redoChange(admin, map, { expectedRevision: revision(map) });
    expect(addressOf(map)).toBe(pasted());
    await singleMapStyles(false);
    expect((await callAs(db, "token", "admin", tokens.admin, "undo_change", { id: map }, revision(map))).status).toBe(200);
    expect(addressOf(map)).toBeNull();
    expect(await callAs(db, "cookie", "admin", tokens.admin, "redo_change", { id: map }, revision(map))).toEqual(REFUSAL);
  });

  it("is refused at the services themselves, whatever road reaches them, and a duplicate keeps what a map holds", async () => {
    const member = testAccountScope(db, "member");
    const held = createMap(member, "held").id, bare = createMap(member, "bare").id;
    const style = { url: pasted(), name: null, attribution: [] };
    // Pasted while allowed, written to the row, so the clear below is the
    // map's only history step.
    db.prepare("UPDATE maps SET custom_basemap = ? WHERE id = ?").run(JSON.stringify(style), held);
    await singleMapStyles(false);
    const coded = { code: "basemap_not_offered", status: 403, extra: { setting: SETTING }, message: SINGLE_MAP_STYLES_OFF };
    expect(() => updateMap(member, bare, { customBasemap: style }, { expectedRevision: revision(bare) })).toThrow(expect.objectContaining(coded));
    expect(addressOf(duplicateMap(member, held).id)).toBe(pasted());
    updateMap(member, held, { customBasemap: null }, { expectedRevision: revision(held) });
    await expect(undoChange(member, held, { expectedRevision: revision(held) })).rejects.toMatchObject(coded);
    expect(asked).toBe(0);
  });

  it("is reported on the runtime read every signed-in account reads", async () => {
    const read = async () => (await (await readConfig(testAccountRequest(new Request(`${ORIGIN}/api/config`), db, "member"))).json()).singleMapStyles;
    expect(await read()).toBe(true);
    await singleMapStyles(false);
    expect(await read()).toBe(false);
  });
});

describe("with style addresses on single maps on, the default", () => {
  it.each(ROADS)("takes any address by %s, read once to check it", async road => {
    const map = createMap(testAccountScope(db, "member"), `pasted by ${road}`).id;
    const answer = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: pasted() } }, revision(map));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(addressOf(map)).toBe(pasted());
    expect(asked).toBe(1);
  });
});
