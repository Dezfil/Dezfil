import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { instanceDefaults } from "@/lib/settings/defaults";
import { POST as createMapRoute } from "@/app/api/maps/route";
import { POST as duplicateMapRoute } from "@/app/api/maps/[id]/duplicate/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { readMap } from "./map-access";
import { updateMap } from "./map-service";
import { opensFramed } from "./map-opening";

/**
 * A map opens at its saved view. Only one still at the starting view it was
 * made with has none of its own, and its first opening frames its data.
 */
const origin = "http://instance.test";
let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function request(actor: string, path: string, method: string, body?: unknown) {
  return testAccountRequest(new Request(origin + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, actor);
}
async function create(): Promise<string> {
  const response = await createMapRoute(request("member", "/api/maps", "POST", { name: "Untitled map" }));
  expect(response.status).toBe(201);
  return String((await response.json()).id);
}
const scope = () => testAccountScope(db, "member");
const framed = (id: string) => opensFramed(readMap(scope(), id).viewport, instanceDefaults(db));
function setView(id: string, viewport: { lng: number; lat: number; zoom: number; pitch?: number; bearing?: number }) {
  updateMap(scope(), id, { viewport }, { expectedRevision: readDocumentRevision({ kind: "map", id }, db)!.editRevision });
}
async function changeDefaults(patch: Record<string, unknown>) {
  const response = await changeInstanceSettings(request("admin", "/api/instance/settings", "PATCH", patch));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}

describe("how a map opens", () => {
  it("frames a new map, under the product's starting view and an administrator's", async () => {
    expect(framed(await create())).toBe(true);
    await changeDefaults({ "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75 });
    expect(framed(await create())).toBe(true);
  });

  it("opens at a saved view, however little it differs from the starting view", async () => {
    const start = readMap(scope(), await create()).viewport;
    for (const change of [{ lng: start.lng + 1e-9 }, { lat: start.lat - 1e-9 }, { zoom: start.zoom + 0.01 }, { pitch: 30 }, { bearing: -10 }]) {
      const id = await create();
      setView(id, { ...start, ...change });
      expect(framed(id), JSON.stringify(change)).toBe(false);
    }
  });

  it("gives a duplicate its source's opening", async () => {
    const unframed = await create(), saved = await create();
    setView(saved, { lng: 2.35, lat: 48.85, zoom: 5 });
    const copies = await Promise.all([unframed, saved].map(async id => {
      const response = await duplicateMapRoute(request("member", `/api/maps/${id}/duplicate`, "POST"), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(201);
      return String((await response.json()).id);
    }));
    expect(copies.map(framed)).toEqual([true, false]);
  });

  it("opens a map made before the starting view moved where its card shows it", async () => {
    const id = await create();
    await changeDefaults({ "newMap.latitude": 52.52, "newMap.longitude": 13.4, "newMap.zoom": 10 });
    expect(framed(id)).toBe(false);
  });
});
