import type { Database } from "better-sqlite3";
import BetterSqlite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "@/lib/metadata/migrations-identities";
import { allocateSqlNames, type SqlNameIdentity } from "@/lib/metadata/sql-names";
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
import * as mapService from "./map-service";
import * as historyRefs from "./map-history-refs";
import { createMap, readMap } from "./map-service";
import { undoChange, redoChange } from "./map-history";

/**
 * A map takes a style the basemap library offers by its id, on every road
 * (session cookie, API token, generated tool, embedded assistant): the
 * server copies the row's name, address and credit onto the map and
 * fetches nothing. The copy is the map's own, so hiding the style and then
 * removing it change neither the map's record nor a publication assembled
 * afresh, and an undo or redo moves the copy, fetching nothing either.
 */

// The style address is a loopback fixture that counts every request it
// answers; a request sent anywhere else fails its test first.
keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
const CREDIT = [{ label: "© Fixture Charts", href: "https://charts.example/terms" }];

let db: Database;
let fixture: Server;
let asked: number;
let address: string;
let tokens: Record<string, string>;

beforeEach(async () => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "");
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  asked = 0;
  fixture = createServer((_req, res) => {
    asked += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 8, sources: { chart: { type: "raster", tiles: ["http://127.0.0.1/t/{z}/{x}/{y}.png"], tileSize: 256,
      attribution: '© <a href="https://charts.example/terms">Fixture Charts</a>' } }, layers: [{ id: "chart", type: "raster", source: "chart" }] }));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", () => resolve()));
  address = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/charts/harbour/style.json`;
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
const customOf = (id: string) => readMap(testAccountScope(db, "member"), id).customBasemap;
/** The copy a map keeps of the library's style. */
const COPY = () => ({ url: address, name: "Harbour chart", attribution: CREDIT });

/** An admin's call on the library's operations, by session cookie. */
async function library(method: string, pathname: string, body?: unknown) {
  const response = await dispatchAssistantTestRoute(testAccountRequest(new Request(`${ORIGIN}${pathname}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, "admin"));
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}
const addStyle = async () => (await library("POST", "/api/instance/basemaps", { name: "Harbour chart", url: address })) as { id: string };

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
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "read", name: "get_map", args: { id: mapId } }] },
    { text: "", toolCalls: [{ id: "take", name: tool, args }] },
    { text: "Done.", toolCalls: [] },
  ]);
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "Use the harbour chart", history: [], context: builderContext(mapId, null, "dark") }, deps)) events.push(event);
  const question = events.find(event => event.type === "confirm_required");
  if (question?.type === "confirm_required") {
    const parked = pending.claim(scope, question.id, "approved")!;
    for await (const event of resumeAssistant(parked, true, deps)) events.push(event);
  }
  const result = events.find(event => event.type === "tool_result" && event.tool === tool);
  if (result?.type !== "tool_result") throw new Error(`expected a result from ${tool}`);
  return result;
}

describe("taking a library style", () => {
  it.each(ROADS)("copies the style onto a map by %s, fetching nothing", async road => {
    const { id } = await addStyle();
    expect(asked).toBe(1);
    const map = createMap(testAccountScope(db, "member"), `taken by ${road}`).id;
    const answer = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as { customBasemap: unknown }).customBasemap).toEqual(COPY());
    expect(customOf(map)).toEqual(COPY());
    expect(asked, "a taking reads the row, never the address").toBe(1);
  });

  it("copies the style when the embedded assistant takes it, fetching nothing", async () => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), "taken by the assistant").id;
    expect(await assistantCall("member", map, "update_map", { id: map, customBasemap: { libraryStyle: id } })).toMatchObject({ ok: true });
    expect(customOf(map)).toEqual(COPY());
    expect(asked).toBe(1);
  });

  it("refuses a hidden, an unknown and a mixed taking, changing nothing", async () => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), "refused").id;
    await library("PATCH", `/api/instance/basemaps/${id}`, { offered: false });
    for (const [customBasemap, message] of [
      [{ libraryStyle: id }, "customBasemap.libraryStyle names no style the basemap library offers now."],
      [{ libraryStyle: "unknown" }, "customBasemap.libraryStyle names no style the basemap library offers now."],
      [{ libraryStyle: "" }, "customBasemap.libraryStyle names no style the basemap library offers now."],
      [{ libraryStyle: id, url: address }, "customBasemap takes either { libraryStyle } or { url, name?, force? }, not both."],
    ] as const) {
      const answer = await callAs(db, "token", "member", tokens.member, "update_map", { id: map, customBasemap }, revision(map));
      expect(answer, JSON.stringify(customBasemap)).toEqual({ status: 400, body: { error: { code: "invalid_request", message } } });
    }
    expect(customOf(map)).toBeNull();
    expect(asked).toBe(1);
  });

  it("lists the offered styles on the runtime read every page load reads, the read fetching nothing", async () => {
    const { id } = await addStyle();
    for (let load = 0; load < 3; load++) {
      const response = await readConfig(testAccountRequest(new Request(`${ORIGIN}/api/config`), db, "member"));
      expect((await response.json()).basemapStyles).toEqual([{ id, ...COPY() }]);
    }
    expect(asked).toBe(1);
  });
});

/** The library's refusal of a take, the same whenever it is judged. */
const NOT_OFFERED = { status: 400, body: { error: { code: "invalid_request", message: "customBasemap.libraryStyle names no style the basemap library offers now." } } };
const content = () => ["maps", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
const offeredNow = (id: string) => (db.prepare("SELECT offered FROM basemap_styles WHERE id = ?").get(id) as { offered: number } | undefined)?.offered === 1;
const CHANGES = {
  hidden: (id: string) => library("PATCH", `/api/instance/basemaps/${id}`, { offered: false }),
  removed: (id: string) => library("DELETE", `/api/instance/basemaps/${id}`),
};

/** Hold the next map write between its admission and the transaction that
 * stores it, where the semantic check is awaited, and let an admin change
 * the library there. The take was admitted with the style offered. */
function holdTheNextWrite(id: string, change: (id: string) => Promise<unknown>) {
  const validate = mapService.validateMapWriteRefs;
  return vi.spyOn(mapService, "validateMapWriteRefs").mockImplementationOnce(async (...args) => {
    expect(offeredNow(id), "admitted while offered").toBe(true);
    await change(id);
    return validate(...args);
  });
}

describe("a take whose admission is held while the style is hidden or removed", () => {
  it.each(ROADS.flatMap(road => (["hidden", "removed"] as const).map(change => [road, change] as const)))(
    "is refused by %s when the style is %s meanwhile, as before it was admitted, changing nothing", async (road, change) => {
      const { id } = await addStyle();
      const map = createMap(testAccountScope(db, "member"), `held by ${road}`).id, before = content();
      const held = holdTheNextWrite(id, CHANGES[change]);
      const answer = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map));
      expect(held).toHaveBeenCalledTimes(1);
      expect(answer).toEqual(NOT_OFFERED);
      expect(content()).toEqual(before);
      expect(customOf(map)).toBeNull();
      expect(asked).toBe(1);
    });

  it.each(["hidden", "removed"] as const)("is refused when the embedded assistant takes it and the style is %s meanwhile", async change => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), "held for the assistant").id, before = content();
    const held = holdTheNextWrite(id, CHANGES[change]);
    expect(await assistantCall("member", map, "update_map", { id: map, customBasemap: { libraryStyle: id } })).toMatchObject({ ok: false, body: NOT_OFFERED.body });
    expect(held).toHaveBeenCalledTimes(1);
    expect(content()).toEqual(before);
    expect(asked).toBe(1);
  });

  it.each(ROADS)("still takes a style offered throughout, held the same way, by %s", async road => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), `kept by ${road}`).id;
    const held = holdTheNextWrite(id, async () => {});
    const answer = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map));
    expect(held).toHaveBeenCalledTimes(1);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(customOf(map)).toEqual(COPY());
  });

  it.each(ROADS)("keeps judging a copy the map holds, and a pasted address, by its address alone (%s)", async road => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), `copy by ${road}`).id;
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map))).status).toBe(200);
    await CHANGES.hidden(id);
    // Saved, and its copy sent again by address, the style hidden.
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, name: `saved by ${road}` }, revision(map))).status).toBe(200);
    const again = await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { url: address, name: "Harbour chart" } }, revision(map));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(customOf(map)?.url).toBe(address);
    // The same address pasted onto another map, the switch on: a pasted address, read to check it.
    const other = createMap(testAccountScope(db, "member"), `pasted by ${road}`).id;
    const pasted = await callAs(db, road, "member", tokens.member, "update_map", { id: other, customBasemap: { url: address } }, revision(other));
    expect(pasted.status, JSON.stringify(pasted.body)).toBe(200);
    expect(customOf(other)?.url).toBe(address);
  });
});

describe("a redo of a take", () => {
  const singleMapStyles = (allowed: boolean) => library("PATCH", "/api/instance/settings", { "basemaps.singleMapStyles": allowed });

  /** A map that took the style, then undid it, so a redo would put the copy back. */
  async function undoneTake(id: string) {
    const member = testAccountScope(db, "member");
    const map = createMap(member, "redone").id;
    expect((await callAs(db, "token", "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map))).status).toBe(200);
    await undoChange(member, map, { expectedRevision: revision(map) });
    expect(customOf(map)).toBeNull();
    return map;
  }

  it("puts the copy back by its address with the switch on, the style hidden: the copy is the map's own", async () => {
    const { id } = await addStyle();
    const map = await undoneTake(id);
    await CHANGES.hidden(id);
    await redoChange(testAccountScope(db, "member"), map, { expectedRevision: revision(map) });
    expect(customOf(map)).toEqual(COPY());
    expect(asked).toBe(1);
  });

  it.each(ROADS)("is refused by %s with the switch off once the style is hidden, judged inside the replay when the hide lands after its admission", async road => {
    const { id } = await addStyle();
    await singleMapStyles(false);
    const map = await undoneTake(id), before = content();
    const assert = historyRefs.assertHistoryRefs;
    const held = vi.spyOn(historyRefs, "assertHistoryRefs").mockImplementationOnce((...args) => {
      expect(offeredNow(id), "admitted while offered").toBe(true);
      db.prepare("UPDATE basemap_styles SET offered = 0 WHERE id = ?").run(id);
      return assert(...args);
    });
    const answer = await callAs(db, road, "member", tokens.member, "redo_change", { id: map }, revision(map));
    expect(held).toHaveBeenCalled();
    expect(answer).toMatchObject({ status: 403, body: { error: { code: "basemap_not_offered", setting: "basemaps.singleMapStyles" } } });
    expect(content()).toEqual(before);
    expect(customOf(map)).toBeNull();
  });
});

describe("a map's copy", () => {
  it.each(ROADS)("keeps its record, a publication assembled afresh and a duplicate after the style is hidden, then removed (%s)", async road => {
    const { id } = await addStyle();
    const map = createMap(testAccountScope(db, "member"), `kept by ${road}`).id;
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map))).status).toBe(200);
    const published = await callAs(db, road, "member", tokens.member, "publish_map", { id: map, theme: "dark" }, revision(map));
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const view = async () => {
      const answer = await callAs(db, road, "member", tokens.member, "view_published_map", { token: (published.body as { token: string }).token });
      expect(answer.status).toBe(200);
      const body = answer.body as Record<string, unknown>;
      return { customBasemap: body.customBasemap, basemapUrl: body.basemapUrl, basemapAttribution: body.basemapAttribution };
    };
    const first = await view();
    expect(first).toEqual({ customBasemap: COPY(), basemapUrl: address, basemapAttribution: CREDIT });

    await library("PATCH", `/api/instance/basemaps/${id}`, { offered: false });
    expect(customOf(map)).toEqual(COPY());
    expect(await view()).toEqual(first);

    await library("DELETE", `/api/instance/basemaps/${id}`);
    expect(customOf(map)).toEqual(COPY());
    expect(await view()).toEqual(first);
    // Saved and duplicated with it, the library gone.
    expect((await callAs(db, road, "member", tokens.member, "update_map", { id: map, name: `saved by ${road}` }, revision(map))).status).toBe(200);
    const copy = await callAs(db, road, "member", tokens.member, "duplicate_map", { id: map });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(customOf((copy.body as { id: string }).id)).toEqual(COPY());
    expect(asked).toBe(1);
  });

  it("is moved by an undo and a redo as it was copied, fetching nothing, the style removed meanwhile", async () => {
    const { id } = await addStyle();
    const member = testAccountScope(db, "member");
    const map = createMap(member, "history").id;
    expect((await callAs(db, "token", "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map))).status).toBe(200);
    await library("DELETE", `/api/instance/basemaps/${id}`);
    await undoChange(member, map, { expectedRevision: revision(map) });
    expect(customOf(map)).toBeNull();
    await redoChange(member, map, { expectedRevision: revision(map) });
    expect(customOf(map)).toEqual(COPY());
    expect(asked).toBe(1);
  });
});

describe("a store from before the library", () => {
  it("reopens with an empty library, every map kept, and takes a style added after", async () => {
    const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR ?? "/tmp", "library-migration-"));
    try {
      const file = path.join(directory, "metadata.sqlite");
      const entry = metadata.MIGRATIONS.findIndex(sql => /CREATE TABLE basemap_styles/.test(sql));
      expect(entry).toBeGreaterThanOrEqual(0);
      const old = new BetterSqlite(file);
      old.pragma("journal_mode = WAL"); old.pragma("foreign_keys = ON");
      old.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
        JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
      for (let version = 0; version < entry; version++) {
        if (metadata.MIGRATIONS[version] === IDENTITIES_MIGRATION) { rebuildIdentities(old, metadata.MIGRATIONS[version], version + 1); continue; }
        old.exec(metadata.MIGRATIONS[version]); old.pragma(`user_version = ${version + 1}`);
      }
      expect(old.pragma("user_version", { simple: true })).toBe(entry);
      expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'basemap_styles'").get()).toBeUndefined();
      old.close();

      // Opened by this version, the migration runs: the library starts
      // empty. Accounts and a map holding a pasted style are made on it.
      db.close();
      db = metadata.open(file);
      vi.mocked(metadata.metadataDb).mockReturnValue(db);
      expect(db.pragma("user_version", { simple: true })).toBe(metadata.MIGRATIONS.length);
      expect(db.prepare("SELECT COUNT(*) AS n FROM basemap_styles").get()).toEqual({ n: 0 });
      testAccountScope(db, "admin");
      db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
      const member = testAccountScope(db, "member");
      tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
      const map = createMap(member, "made before").id;
      const pasted = { url: "https://styles.example/pasted.json", name: "Pasted", attribution: [{ label: "styles.example" }] };
      db.prepare("UPDATE maps SET custom_basemap = ? WHERE id = ?").run(JSON.stringify(pasted), map);

      // Opened again: nothing moves, and the library works.
      db.close();
      db = metadata.open(file);
      vi.mocked(metadata.metadataDb).mockReturnValue(db);
      expect(customOf(map)).toEqual(pasted);
      const { id } = await addStyle();
      expect((await callAs(db, "token", "member", tokens.member, "update_map", { id: map, customBasemap: { libraryStyle: id } }, revision(map))).status).toBe(200);
      expect(customOf(map)).toEqual(COPY());
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
