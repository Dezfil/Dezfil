import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
const limit = 16_777_216;
let db: Database, mapId: string;
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const scope = testAccountScope(db); mapId = createMap(scope, "Bounds").id;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO layers (id,map_id,name,sql,style,ordinal,created_at,updated_at) VALUES ('L',?,'Layer','SELECT 1',?,0,?,?)").run(mapId, JSON.stringify(defaultStyle(null)), now, now);
  db.prepare("INSERT INTO projects (id,name,owner_id,created_at,updated_at) VALUES ('P','Project',?,?,?)").run(scope.accountId, now, now);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const cases = [
  ["maps", "POST"], ["maps/[id]", "PATCH"], ["maps/[id]/layers", "POST"], ["maps/[id]/sketches", "POST"],
  ["maps/[id]/widget-values", "POST"], ["maps/[id]/publish", "POST"], ["maps/[id]/export/image", "POST"], ["maps/look", "POST"], ["maps/[id]/transfer", "POST"],
  ["layers/[id]", "PATCH"], ["layers/[id]/render", "POST"], ["layers/[id]/extent", "POST"], ["layers/[id]/fill", "POST"], ["layers/[id]/scale", "POST"],
  ["sketches/[name]/features", "POST"], ["sketches/[name]/features/[featureId]", "PATCH"],
  ["projects", "POST"], ["projects/[id]", "PATCH"], ["projects/[id]/export", "POST"], ["projects/[id]/transfer", "POST"], ["projects/[id]/members", "PATCH"], ["projects/[id]/people/[sqlName]", "PUT"],
];
const modules = import.meta.glob("../../app/api/**/route.ts");
const snapshot = () => ["maps", "layers", "projects", "project_people", "data_tables", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
it.each(cases)("bounds %s %s before parsing or mutation", async (route, method) => {
  const handler = (await modules[`../../app/api/${route}/route.ts`]()) as Record<string, (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  expect(handler[method]).toBeTypeOf("function");
  for (const declared of [false, true]) {
    const bytes = limit + 1, id = route.startsWith("maps") ? mapId : route.startsWith("layers") ? "L" : "P";
    const req = testAccountRequest(new Request(`http://instance.test/api/${route}`, { method, body: declared ? "{}" : "{}" + " ".repeat(bytes - 2), headers: { "content-type": "text/plain", ...(declared ? { "content-length": String(bytes) } : {}) } }), db);
    req.headers.set("x-edit-revision", readDocumentRevision({ kind: "map", id: mapId }, db)!.editRevision!);
    const before = snapshot(), get = vi.spyOn(req, "body", "get");
    const response = await handler[method](req, { params: Promise.resolve({ id, name: "missing", featureId: "1", sqlName: "missing" }) });
    expect(response.status, route + " " + await response.clone().text()).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "request_body_too_large", message: "The request body exceeds the 16777216-byte limit." } });
    if (declared) expect(get).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  }
});
