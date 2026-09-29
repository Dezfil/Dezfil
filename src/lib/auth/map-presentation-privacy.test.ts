import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import { GET as readMap, PATCH as writeMap } from "@/app/api/maps/[id]/route";
import { GET as readLayer, PATCH as writeLayer } from "@/app/api/layers/[id]/route";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";

const inspection = vi.hoisted(() => vi.fn(async () => ({ verdict: "valid", attribution: [{ label: "Style owner" }] })));
vi.mock("@/lib/net/inspect-style", async original => ({ ...await original<typeof import("@/lib/net/inspect-style")>(), inspectStyle: inspection }));
const actors = ["alice", "bob", "admin"];
let db: Database, maps: Record<string, string>;
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); maps = {};
  for (const actor of actors) {
    maps[actor] = createMap(testAccountScope(db, actor), actor + " private map").id;
    db.prepare("INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES (?, ?, ?, 'SELECT 1', ?, 0, 'time', 'time')")
      .run(`layer-${actor}`, maps[actor], actor + " private style", JSON.stringify(defaultStyle(null)));
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run(); inspection.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function request(actor: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const input = testAccountRequest(new Request("http://instance.test" + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, actor);
  if (kind === "token") { const token = createApiToken(requireRequestAuth(input, db), "Style", db); input.headers.delete("cookie"); input.headers.set("authorization", `Bearer ${token.secret}`); }
  return input;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const snapshot = () => ["maps", "layers", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

it.each(["session", "token"])("keeps map basemaps and layer styles private to each %s owner, including admins", async kind => {
  for (const actor of actors) {
    const customBasemap = { url: `https://${actor}.test/private-style.json`, name: actor + " private basemap" };
    const written = await writeMap(request(actor, `/api/maps/${maps[actor]}`, "PATCH", { basemap: "light", customBasemap }, kind), params(maps[actor]));
    expect(written.status).toBe(200); expect(await written.json()).toMatchObject({ customBasemap });
    const style = { ...defaultStyle(null), opacity: actor === "alice" ? 0.2 : actor === "bob" ? 0.4 : 0.6 };
    expect((await writeLayer(request(actor, `/api/layers/layer-${actor}`, "PATCH", { style }, kind), params(`layer-${actor}`))).status).toBe(200);
    expect(await (await readLayer(request(actor, `/api/layers/layer-${actor}`, "GET", undefined, kind), params(`layer-${actor}`))).json()).toMatchObject({ style });
  }
  expect(inspection).toHaveBeenCalledTimes(3); inspection.mockClear();
  const before = snapshot();
  for (const actor of actors) for (const owner of actors.filter(id => id !== actor)) {
    for (const [path, id, handler, body] of [
      ["maps", maps[owner], readMap, undefined],
      ["maps", maps[owner], writeMap, { customBasemap: { url: "https://refused.test/style.json" } }],
      ["layers", `layer-${owner}`, readLayer, undefined],
      ["layers", `layer-${owner}`, writeLayer, { style: defaultStyle(null) }],
    ] as const) {
      const response = await handler(request(actor, `/api/${path}/${id}`, body ? "PATCH" : "GET", body, kind), params(id));
      const missing = await handler(request(actor, `/api/${path}/missing`, body ? "PATCH" : "GET", body, kind), params("missing"));
      expect(response.status).toBe(404); expect(missing.status).toBe(404);
      expect(await response.json()).toEqual(await missing.json());
    }
  }
  expect(snapshot()).toEqual(before); expect(inspection).not.toHaveBeenCalled();
});
