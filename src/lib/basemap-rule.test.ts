import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, tokenFor } from "@/lib/test-support/rule-roads";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { builderContext } from "@/components/builder/assistant/builder-context";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { BASEMAPS } from "./basemap";
import { createMap, duplicateMap, updateMap } from "./map-service";
import { undoChange } from "./map-history";

/**
 * A basemap an admin hid is refused when it would newly be put on a map, by
 * every road a person or an agent takes (their session cookie, an API
 * token, the generated tool and the embedded assistant), naming the switch
 * that hides it; an undo or redo that would put it back is refused the same
 * way. Whatever a map is already on is kept: a map on a hidden style is
 * saved, duplicated and published with it. Hiding is for everyone, admins
 * included, and Auto is always offered.
 */
const STREETS = BASEMAPS.find(b => b.key === "streets")!;
const HIDDEN = "Streets is not offered on this instance, so no map can be put on it now. A map already on it keeps it; an admin can offer it again.";
const refusal = (setting: string, message = HIDDEN) => ({ status: 403, body: { error: { code: "basemap_not_offered", message, setting } } });

interface Owned { dark: string; streets: string; restorable: string }
let db: Database;
let tokens: Record<string, string>;
let owned: Record<string, Owned>;
const revision = (id: string) => readDocumentRevision({ kind: "map", id }, db)!.editRevision!;
const basemapOf = (id: string) => (db.prepare("SELECT basemap FROM maps WHERE id = ?").get(id) as { basemap: string | null }).basemap;
const content = () => ["maps", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

/** An account's maps, made while every style was offered: one on Dark, one
 * on Streets, and one on Streets moved to Dark, so its undo would put Streets
 * back. The starting basemaps are written straight to the row, so the move
 * is the map's only history step (steps a few seconds apart coalesce). */
function seed(account: string): Owned {
  const scope = testAccountScope(db, account);
  const make = (name: string, basemap: string) => {
    const id = createMap(scope, `${account} ${name}`).id;
    db.prepare("UPDATE maps SET basemap = ? WHERE id = ?").run(basemap, id);
    return id;
  };
  const dark = make("dark", "dark"), streets = make("streets", "streets"), restorable = make("restorable", "streets");
  updateMap(scope, restorable, { basemap: "dark" }, { expectedRevision: revision(restorable) });
  return { dark, streets, restorable };
}

beforeEach(() => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "");
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  owned = { admin: seed("admin"), member: seed("member") };
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

async function offer(patch: Record<string, unknown>) {
  const response = await changeInstanceSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }), db, "admin"));
  expect(response.status).toBe(200);
}

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
  const deps = { scope, baseUrl: "http://instance.test", pending, fetchImpl: dispatch };
  // The assistant reads the map first, as it must, to learn its edit revision.
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "read", name: "get_map", args: { id: mapId } }] },
    { text: "", toolCalls: [{ id: "choose", name: tool, args }] },
    { text: "Done.", toolCalls: [] },
  ]);
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "Change the basemap", history: [], context: builderContext(mapId, null, "dark") }, deps)) events.push(event);
  const question = events.find(event => event.type === "confirm_required");
  if (question?.type === "confirm_required") {
    const parked = pending.claim(scope, question.id, "approved")!;
    for await (const event of resumeAssistant(parked, true, deps)) events.push(event);
  }
  const result = events.find(event => event.type === "tool_result" && event.tool === tool);
  if (result?.type !== "tool_result") throw new Error(`expected a result from ${tool}`);
  return result;
}

describe("a basemap an admin hid", () => {
  it.each(ROADS)("is refused when newly chosen for a map by %s, naming its switch, for a member and an admin alike, changing nothing", async road => {
    await offer({ "basemaps.streets": false });
    for (const actor of ["member", "admin"]) {
      const map = owned[actor].dark, before = content();
      const answer = await callAs(db, road, actor, tokens[actor], "update_map", { id: map, basemap: "streets" }, revision(map));
      expect(answer, actor).toEqual(refusal("basemaps.streets"));
      expect(content(), actor).toEqual(before);
    }
  });

  it("is refused when the embedded assistant chooses it, naming its switch, changing nothing", async () => {
    await offer({ "basemaps.streets": false });
    const map = owned.member.dark, before = content();
    const result = await assistantCall("member", map, "update_map", { id: map, basemap: "streets" });
    expect(result).toMatchObject({ ok: false, body: refusal("basemaps.streets").body });
    expect(content()).toEqual(before);
  });

  it("is refused for Satellite, named by its own switch, whether or not imagery is set up", async () => {
    await offer({ "basemaps.satellite": false });
    const map = owned.member.dark;
    const answer = await callAs(db, "token", "member", tokens.member, "update_map", { id: map, basemap: "satellite" }, revision(map));
    expect(answer).toEqual(refusal("basemaps.satellite",
      "Satellite is not offered on this instance, so no map can be put on it now. A map already on it keeps it; an admin can offer it again."));
    expect(basemapOf(map)).toBe("dark");
  });

  it.each(ROADS)("leaves Auto and every offered style to choose by %s, and Streets again once offered", async road => {
    await offer({ "basemaps.streets": false });
    const map = owned.member.dark;
    for (const basemap of [null, "light", "dark"]) {
      const answer = await callAs(db, road, "member", tokens.member, "update_map", { id: map, basemap }, revision(map));
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(basemapOf(map)).toBe(basemap);
    }
    await offer({ "basemaps.streets": true });
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, basemap: "streets" }, revision(map))).status).toBe(200);
    expect(basemapOf(map)).toBe("streets");
  });

  it.each(ROADS)("keeps a map already on it: saved, its choice sent again, duplicated and published by %s", async road => {
    await offer({ "basemaps.streets": false });
    const map = owned.member.streets, token = tokens.member;
    expect((await callAs(db, road, "member", token, "update_map", { id: map, name: `kept by ${road}` }, revision(map))).status).toBe(200);
    expect((await callAs(db, road, "member", token, "update_map", { id: map, basemap: "streets", basemapLayers: { labels: false } }, revision(map))).status).toBe(200);
    expect(basemapOf(map)).toBe("streets");
    const copy = await callAs(db, road, "member", token, "duplicate_map", { id: map });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(basemapOf((copy.body as { id: string }).id)).toBe("streets");
    const published = await callAs(db, road, "member", token, "publish_map", { id: map, theme: "dark" }, revision(map));
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const view = await callAs(db, road, "member", token, "view_published_map", { token: (published.body as { token: string }).token });
    expect(view.status).toBe(200);
    // Assembled afresh on the style the map is on, hidden or not.
    expect(view.body).toMatchObject({ basemapKey: "streets", basemapUrl: STREETS.url, basemapKind: "vector", basemapAttribution: STREETS.attribution });
  });

  it("keeps a map already on it when the embedded assistant saves it", async () => {
    await offer({ "basemaps.streets": false });
    const map = owned.member.streets;
    expect(await assistantCall("member", map, "update_map", { id: map, name: "kept by the assistant" })).toMatchObject({ ok: true });
    expect(basemapOf(map)).toBe("streets");
  });

  it.each(ROADS)("is refused when an undo would put it back by %s, and the history read says why", async road => {
    await offer({ "basemaps.streets": false });
    const map = owned.member.restorable, before = content();
    const history = await callAs(db, road, "member", tokens.member, "get_history", { id: map });
    expect((history.body as { undoTarget: unknown }).undoTarget).toMatchObject({ eligible: false, reason: HIDDEN });
    const answer = await callAs(db, road, "member", tokens.member, "undo_change", { id: map }, revision(map));
    expect(answer).toEqual(refusal("basemaps.streets"));
    expect(content()).toEqual(before);
    expect(basemapOf(map)).toBe("dark");
  });

  it("is refused when a redo would put it back, and an undo leaving it is kept", async () => {
    const member = testAccountScope(db, "member"), map = owned.member.dark;
    updateMap(member, map, { basemap: "streets" }, { expectedRevision: revision(map) });
    await undoChange(member, map, { expectedRevision: revision(map) });
    expect(basemapOf(map)).toBe("dark");
    await offer({ "basemaps.streets": false });
    expect(await callAs(db, "token", "member", tokens.member, "redo_change", { id: map }, revision(map))).toEqual(refusal("basemaps.streets"));
    expect(basemapOf(map)).toBe("dark");
    // On Streets again while it was offered: an undo that takes it away is kept.
    await offer({ "basemaps.streets": true });
    expect((await callAs(db, "token", "member", tokens.member, "redo_change", { id: map }, revision(map))).status).toBe(200);
    await offer({ "basemaps.streets": false });
    expect((await callAs(db, "token", "member", tokens.member, "undo_change", { id: map }, revision(map))).status).toBe(200);
    expect(basemapOf(map)).toBe("dark");
  });

  it.each(ROADS)("as the new-map default, creates a map on Auto by %s, and on it again once offered", async road => {
    await offer({ "newMap.basemap": "streets", "basemaps.streets": false });
    const created = await callAs(db, road, "member", tokens.member, "create_map", { name: `new by ${road}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(basemapOf((created.body as { id: string }).id)).toBeNull();
    await offer({ "basemaps.streets": true });
    const again = await callAs(db, road, "member", tokens.member, "create_map", { name: `again by ${road}` });
    expect(basemapOf((again.body as { id: string }).id)).toBe("streets");
  });

  it("is refused at the services themselves, whatever road reaches them, and a duplicate keeps it", async () => {
    await offer({ "basemaps.streets": false });
    const member = testAccountScope(db, "member"), maps = owned.member;
    const coded = { code: "basemap_not_offered", status: 403, extra: { setting: "basemaps.streets" }, message: HIDDEN };
    expect(() => updateMap(member, maps.dark, { basemap: "streets" }, { expectedRevision: revision(maps.dark) })).toThrow(expect.objectContaining(coded));
    await expect(undoChange(member, maps.restorable, { expectedRevision: revision(maps.restorable) })).rejects.toMatchObject(coded);
    expect(basemapOf(duplicateMap(member, maps.streets).id)).toBe("streets");
  });
});
