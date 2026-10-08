import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, ruleRefusalBody, tokenFor, type Road } from "@/lib/test-support/rule-roads";
import { createMap, updateMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { publishMap } from "./publish-service";

/**
 * Who may publish, on every road a person or an agent takes. A narrowed rule
 * refuses new reach and takes nothing away: publishing a map and changing a
 * live publication's settings (its theme, its reader controls, a layer's
 * published fields, the widget toggle, and an undo or redo that would put one
 * of them back) are refused, while a published map stays public, follows its
 * map's edits and can be unpublished. Admins only lets admins through; No one
 * stops admins too.
 */
const ADMINS_ONLY = "Only admins can publish maps on this instance.";
const NO_ONE = "No one can publish maps on this instance.";

interface Owned { draft: string; live: string; layer: string; token: string }
let db: Database;
let tokens: Record<string, string>;
let owned: Record<string, Owned>;

const revision = (id: string) => readDocumentRevision({ kind: "map", id }, db)!.editRevision!;

/** An account's maps: one never published, and one published while everyone
 * could, its last history step turning its widgets off, with a hidden layer
 * whose published fields are a list. */
function seed(account: string): Owned {
  const scope = testAccountScope(db, account);
  const draft = createMap(scope, `${account} draft`).id;
  const live = createMap(scope, `${account} live`).id;
  const layer = `${account}-layer`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, visible, ordinal, created_at, updated_at, published_fields)
    VALUES (?, ?, 'Points', 'SELECT 1', ?, 0, 0, ?, ?, '["name"]')`).run(layer, live, JSON.stringify(defaultStyle("POINT")), now, now);
  updateMap(scope, live, { widgetsPublished: false }, { expectedRevision: revision(live) });
  const { token } = publishMap(scope, live, { theme: "dark" }, { expectedRevision: revision(live) });
  return { draft, live, layer, token };
}

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  owned = { admin: seed("admin"), member: seed("member") };
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function setPublishing(value: "everyone" | "admins" | "none") {
  const response = await changeInstanceSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ "publishing.publish": value }),
  }), db, "admin"));
  expect(response.status).toBe(200);
}
/** Every map, layer and history row: a refused request leaves them as they were. */
const content = () => ["maps", "layers", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

/** Each change a narrowed rule refuses, as its operation takes it. */
function refusedChanges(maps: Owned): [string, string, Record<string, unknown>, string][] {
  return [
    ["publishing anew", "publish_map", { id: maps.draft }, maps.draft],
    ["a theme change", "publish_map", { id: maps.live, theme: "light" }, maps.live],
    ["a reader controls change", "publish_map", { id: maps.live, viewerControls: { tilt: false } }, maps.live],
    ["a published fields change", "update_layer", { id: maps.layer, publishedFields: null }, maps.live],
    ["the widget toggle", "update_map", { id: maps.live, widgetsPublished: true }, maps.live],
    ["an undo that puts the widget toggle back", "undo_change", { id: maps.live }, maps.live],
  ];
}

/** Everything a narrowed rule keeps: the link answers, the map's edits reach
 * it, a call that changes nothing answers with the same link, an undo of
 * content works, and the owner can unpublish. */
async function keeps(road: Road, actor: string) {
  const maps = owned[actor], token = tokens[actor];
  expect((await callAs(db, road, actor, token, "view_published_map", { token: maps.token })).status).toBe(200);
  const renamed = `${actor} renamed by ${road}`;
  expect((await callAs(db, road, actor, token, "update_map", { id: maps.live, name: renamed }, revision(maps.live))).status).toBe(200);
  const view = await callAs(db, road, actor, token, "view_published_map", { token: maps.token });
  expect((view.body as { name: string }).name).toBe(renamed);
  const same = await callAs(db, road, actor, token, "publish_map", { id: maps.live, theme: "dark" }, revision(maps.live));
  expect(same.status).toBe(201);
  expect((same.body as { token: string }).token).toBe(maps.token);
  expect((await callAs(db, road, actor, token, "undo_change", { id: maps.live }, revision(maps.live))).status).toBe(200);
  expect((await callAs(db, road, actor, token, "view_published_map", { token: maps.token })).body).toMatchObject({ name: `${actor} live` });
  expect((await callAs(db, road, actor, token, "unpublish_map", { id: maps.live }, revision(maps.live))).status).toBe(200);
  expect((await callAs(db, road, actor, token, "view_published_map", { token: maps.token })).status).toBe(404);
}

describe("who may publish", () => {
  for (const [value, sentence] of [["admins", ADMINS_ONLY], ["none", NO_ONE]] as const) {
    it.each(ROADS)(`under ${value}, refuses a member each publication change by %s, naming the rule, changing nothing`, async road => {
      await setPublishing(value);
      for (const [label, tool, args, map] of refusedChanges(owned.member)) {
        const before = content();
        const answer = await callAs(db, road, "member", tokens.member, tool, args, revision(map));
        expect(answer, label).toEqual({ status: 403, body: ruleRefusalBody("publishing.publish", sentence) });
        expect(content(), label).toEqual(before);
      }
    });

    it.each(ROADS)(`under ${value}, keeps a member's published map public, following its edits and unpublishable by %s`, async road => {
      await setPublishing(value);
      await keeps(road, "member");
    });
  }

  it.each(ROADS)("under admins, lets an admin make every publication change by %s", async road => {
    await setPublishing("admins");
    for (const [label, tool, args, map] of refusedChanges(owned.admin)) {
      const answer = await callAs(db, road, "admin", tokens.admin, tool, args, revision(map));
      expect(answer.status, `${label}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    }
    // Published anew, its theme and a control changed, the fields reset, and
    // the widget toggle turned on and then undone.
    const live = db.prepare("SELECT published_theme, viewer_controls, widgets_published FROM maps WHERE id = ?").get(owned.admin.live) as
      { published_theme: string; viewer_controls: string; widgets_published: number };
    expect(live.published_theme).toBe("light");
    expect(JSON.parse(live.viewer_controls)).toMatchObject({ tilt: false });
    expect(live.widgets_published).toBe(0);
    expect(db.prepare("SELECT published_fields FROM layers WHERE id = ?").get(owned.admin.layer)).toEqual({ published_fields: null });
    expect(db.prepare("SELECT publish_token IS NOT NULL AS live FROM maps WHERE id = ?").get(owned.admin.draft)).toEqual({ live: 1 });
  });

  it.each(ROADS)("under none, refuses an admin each publication change by %s and keeps the rest", async road => {
    await setPublishing("none");
    for (const [label, tool, args, map] of refusedChanges(owned.admin)) {
      const before = content();
      const answer = await callAs(db, road, "admin", tokens.admin, tool, args, revision(map));
      expect(answer, label).toEqual({ status: 403, body: ruleRefusalBody("publishing.publish", NO_ONE) });
      expect(content(), label).toEqual(before);
    }
    await keeps(road, "admin");
  });

  it.each(ROADS)("under everyone, lets a member make every publication change by %s", async road => {
    for (const [label, tool, args, map] of refusedChanges(owned.member)) {
      const answer = await callAs(db, road, "member", tokens.member, tool, args, revision(map));
      expect(answer.status, `${label}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    }
  });

  it("explains a refused undo in the history read with the rule's sentence", async () => {
    await setPublishing("admins");
    const history = await callAs(db, "token", "member", tokens.member, "get_history", { id: owned.member.live });
    expect(history.status).toBe(200);
    expect((history.body as { undoTarget: unknown }).undoTarget).toMatchObject({ eligible: false, reason: ADMINS_ONLY });
  });

  it("refuses at the services themselves, whatever road reaches them", async () => {
    await setPublishing("admins");
    const member = testAccountScope(db, "member"), maps = owned.member;
    const refusal = { code: "rule_refused", status: 403, extra: { rule: "publishing.publish" }, message: ADMINS_ONLY };
    expect(() => publishMap(member, maps.draft, {}, { expectedRevision: revision(maps.draft) })).toThrow(expect.objectContaining(refusal));
    expect(() => updateMap(member, maps.live, { widgetsPublished: true }, { expectedRevision: revision(maps.live) })).toThrow(expect.objectContaining(refusal));
  });
});
