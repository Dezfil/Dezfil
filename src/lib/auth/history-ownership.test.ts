import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap, undoChange, redoChange } from "@/lib/map-service";
import { recordStep, setHistoryCursor } from "@/lib/metadata/history";
import { getLayer } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
const effects = vi.hoisted(() => ({ tiles: vi.fn(async () => {}) }));
vi.mock("@/lib/tiles/build", () => ({ removeTileArtifacts: effects.tiles }));
let db: Database;
let maps: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); maps = {};
  for (const account of accounts) {
    maps[account] = createMap(testAccountScope(db, account), `Private ${account}`).id;
    db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, ?, 'SELECT 1 AS secret', ?, 0, 'time', 'time')`).run(`layer-${account}`, maps[account], `Secret ${account}`, JSON.stringify(defaultStyle(null)));
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run(); vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function input(account: string, id: string, method: string, kind: string) {
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${id}/history`, { method }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "History", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
function snapshot() { return ["maps", "layers", "map_history"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()); }
it.each(["read", "undo", "redo"])("refuses hidden history %s through cookies and tokens without effects", async action => {
  const route = action === "read" ? await import("@/app/api/maps/[id]/history/route") : action === "undo" ? await import("@/app/api/maps/[id]/undo/route") : await import("@/app/api/maps/[id]/redo/route");
  const handler = "GET" in route ? route.GET : route.POST;
  const before = snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const hidden = await handler(input(account, maps[other], action === "read" ? "GET" : "POST", kind), { params: Promise.resolve({ id: maps[other] }) });
    const absent = await handler(input(account, "missing", action === "read" ? "GET" : "POST", kind), { params: Promise.resolve({ id: "missing" }) });
    expect(hidden.status).toBe(404); expect(absent.status).toBe(404); expect(await hidden.json()).toEqual(await absent.json());
    expect(snapshot()).toEqual(before); expect(effects.tiles).not.toHaveBeenCalled();
  }
});
function widget(layerId: string) { return { id: "widget", type: "formula", layerId, title: "Count", field: null,
  agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }; }
const cases = ["map target", "layer target", "delete target", "restore parent", "restore identity", "restore collision", "widgets", "timeline", "layerOrder", "legendOrder"];
it.each(cases)("refuses replay %s references atomically for hidden and missing identities", async kind => {
  for (const direction of ["undo", "redo"] as const) for (const hidden of [true, false]) {
    // An absent restore target is legitimate; collision only concerns a live row.
    if (kind === "restore collision" && !hidden) continue;
    db.prepare("DELETE FROM map_history").run(); setHistoryCursor(maps.alice, 0);
    const foreignLayer = hidden ? "layer-bob" : "missing-layer", foreignMap = hidden ? maps.bob : "missing-map";
    let scope: "map" | "layer" = "map", targetId = maps.alice, op: "update" | "add" | "delete" = "update";
    let image: Record<string, unknown> = { name: "Changed" };
    if (kind === "map target") targetId = foreignMap;
    if (kind === "layer target" || kind === "delete target") { scope = "layer"; targetId = foreignLayer; }
    if (kind === "delete target") op = direction === "undo" ? "add" : "delete";
    if (kind.startsWith("restore")) {
      scope = "layer"; targetId = "restored"; op = direction === "undo" ? "delete" : "add";
      image = { ...getLayer("layer-alice")!, id: targetId };
      if (kind === "restore parent") image.mapId = foreignMap;
      if (kind === "restore identity") image.id = foreignLayer;
      if (kind === "restore collision") { targetId = foreignLayer; image.id = foreignLayer; }
    }
    if (kind === "widgets") image = { widgets: [widget(foreignLayer)] };
    if (kind === "timeline") image = { timeline: { layerId: foreignLayer, field: "time", speed: 1 } };
    if (kind === "layerOrder" || kind === "legendOrder") image = { [kind]: [foreignLayer] };
    // A legitimate member in the same gesture must not survive a refused member.
    const safe = () => recordStep({ mapId: maps.alice, scope: "map", targetId: maps.alice, op: "update", before: { name: "Safe before" }, after: { name: "Safe after" }, groupId: "compound" });
    const unsafe = () => recordStep({ mapId: maps.alice, scope, targetId, op,
      before: op === "add" ? null : image, after: op === "delete" ? null : image, groupId: "compound" });
    if (direction === "undo") { unsafe(); safe(); } else { safe(); unsafe(); setHistoryCursor(maps.alice, 0); }
    const before = snapshot();
    await expect((direction === "undo" ? undoChange : redoChange)(testAccountScope(db, "alice"), maps.alice)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(snapshot()).toEqual(before); expect(effects.tiles).not.toHaveBeenCalled();
  }
});
it("keeps layer references inside the exact parent even for two maps of one owner", async () => {
  const other = createMap(testAccountScope(db, "alice"), "Other");
  recordStep({ mapId: other.id, scope: "layer", targetId: "layer-alice", op: "update", before: { name: "Changed" }, after: { name: "After" } });
  const before = snapshot();
  await expect(undoChange(testAccountScope(db, "alice"), other.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(snapshot()).toEqual(before);
});
