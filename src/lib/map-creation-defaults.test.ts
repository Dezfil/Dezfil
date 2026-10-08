import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "@/lib/auth/http";
import { createApiToken } from "@/lib/auth/credentials";
import { createProject } from "@/lib/metadata/owned-projects";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { POST as createMapRoute } from "@/app/api/maps/route";
import { POST as duplicateMapRoute } from "@/app/api/maps/[id]/duplicate/route";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { updateMap } from "./map-service";

/**
 * A new map starts from the instance's defaults, whichever path makes it:
 * the Maps screen's call, the API, the generated tool. A duplicate is not a
 * new map: it keeps what its source stores, unset values included.
 */
const origin = "http://instance.test";
const IMAGERY = "https://imagery.example/{z}/{x}/{y}.jpg";

/** Every map default an admin can change, none at the product's value. */
const MAP_DEFAULTS = {
  "newMap.basemap": "satellite", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093,
  "newMap.zoom": 9.75, "newMap.legendCorner": "top-right",
};
/** What a map made under those defaults stores. */
const TAKEN = { basemap: "satellite", legend_corner: "top-right", view_lat: -33.8688, view_lng: 151.2093, view_zoom: 9.75 };
/** What a map made under the product's values stores: no basemap and no
 * corner, so it keeps reading Auto and each surface's own fallback corner. */
const PRODUCT = { basemap: null, legend_corner: null, view_lat: 40, view_lng: 0, view_zoom: 1.3 };

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.stubEnv("DEZFIL_SATELLITE_URL", IMAGERY);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

function request(actor: string, path: string, method: string, body?: unknown) {
  return testAccountRequest(new Request(origin + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, actor);
}
/** An admin changes the defaults through the change operation. */
async function changeDefaults(patch: Record<string, unknown>) {
  const response = await changeInstanceSettings(request("admin", "/api/instance/settings", "PATCH", patch));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}
const stored = (id: string) => db.prepare(
  "SELECT basemap, legend_corner, view_lat, view_lng, view_zoom FROM maps WHERE id = ?").get(id);

/** The Maps screen's own call, as a member. */
async function createByScreen(): Promise<Record<string, unknown>> {
  const response = await createMapRoute(request("member", "/api/maps", "POST", { name: "Untitled map" }));
  expect(response.status).toBe(201);
  return response.json();
}

/** The three ways a map is made, each as a member: the Maps screen's own
 * body, the API filing the map into a project at birth, and the generated
 * tool an agent calls. */
async function createEveryWay(): Promise<Record<string, unknown>[]> {
  const screen = await createMapRoute(request("member", "/api/maps", "POST", { name: "Untitled map" }));
  const project = createProject(testAccountScope(db, "member"), { name: "Survey" }, db);
  const api = await createMapRoute(request("member", "/api/maps", "POST", { name: "Filed", projectId: project.id }));
  const token = createApiToken(requireRequestAuth(request("member", "/api/account", "GET"), db), "Agent", db).secret;
  const tool = await executeTool(buildTools().find(candidate => candidate.name === "create_map")!, { name: "Agent map" }, origin,
    (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch,
    { authorization: `Bearer ${token}` });
  expect([screen.status, api.status, tool.status]).toEqual([201, 201, 201]);
  const made = [await screen.json(), await api.json(), tool.body] as Record<string, unknown>[];
  expect(made.map(map => map.name)).toEqual(["Untitled map", "Filed", "Agent map"]);
  expect(made[1].projectId).toBe(project.id);
  return made;
}

describe("a new map", () => {
  it("takes the basemap, starting view and legend corner an admin set, on every creating path", async () => {
    await changeDefaults(MAP_DEFAULTS);
    for (const map of await createEveryWay()) {
      expect(stored(String(map.id))).toEqual(TAKEN);
      expect(map).toMatchObject({ basemap: "satellite", legendCorner: "top-right", viewport: { lat: -33.8688, lng: 151.2093, zoom: 9.75 } });
    }
  });

  it("is stored as before with nothing stored, and with the product's own values stored", async () => {
    for (const map of await createEveryWay()) expect(stored(String(map.id))).toEqual(PRODUCT);
    await changeDefaults({ "newMap.basemap": "auto", "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": "bottom-left" });
    for (const map of await createEveryWay()) expect(stored(String(map.id))).toEqual(PRODUCT);
  });

  it("starts on Auto when the Basemap default is Satellite and the instance offers no imagery", async () => {
    await changeDefaults(MAP_DEFAULTS);
    vi.stubEnv("DEZFIL_SATELLITE_URL", "");
    for (const map of await createEveryWay()) expect(stored(String(map.id))).toEqual({ ...TAKEN, basemap: null });
    vi.stubEnv("DEZFIL_SATELLITE_URL", IMAGERY);
    for (const map of await createEveryWay()) expect(stored(String(map.id))).toEqual(TAKEN);
  });
});

describe("a duplicate", () => {
  it("keeps its source's basemap, view and legend corner after every map default changed, unset ones included", async () => {
    const unset = await createByScreen(), chosen = await createByScreen();
    const scope = testAccountScope(db, "member"), id = String(chosen.id);
    updateMap(scope, id, { basemap: "light", legendCorner: "bottom-right", viewport: { lng: 2.35, lat: 48.85, zoom: 5 } },
      { expectedRevision: readDocumentRevision({ kind: "map", id }, db)!.editRevision });
    const sources = [unset, chosen].map(map => stored(String(map.id)));
    expect(sources).toEqual([PRODUCT, { basemap: "light", legend_corner: "bottom-right", view_lat: 48.85, view_lng: 2.35, view_zoom: 5 }]);
    await changeDefaults(MAP_DEFAULTS);
    for (const [i, source] of [unset, chosen].entries()) {
      const response = await duplicateMapRoute(request("member", `/api/maps/${source.id}/duplicate`, "POST"),
        { params: Promise.resolve({ id: String(source.id) }) });
      expect(response.status).toBe(201);
      expect(stored(String((await response.json()).id))).toEqual(sources[i]);
    }
  });
});
