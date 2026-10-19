import { publishMap } from "@/lib/publish/publication-state";
import { createProject, fileMap } from "@/lib/metadata/owned-projects";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it, vi } from "vitest";
import path from "node:path";
import { POST as createRoute } from "@/app/api/maps/route";
import { POST as duplicateRoute } from "@/app/api/maps/[id]/duplicate/route";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import { undoChange, redoChange } from "@/lib/map-history";
import { documentFacts } from "@/lib/metadata/document-facts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { copyTemplate } from "@/lib/templates/copy";
import * as shipped from "@/lib/templates/shipped-index";
import { buildTemplate, writeShippedFolder } from "../../../test-support/templates/builder";
import { observePictureChanges } from "./hooks";
import { PictureService } from "./service";
import { pictureTarget, publishPicture } from "./publication";
import { getPictureState } from "./state";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
isolatePictureData();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
function harness() {
  let now = Date.now(); const launches: string[] = [], jobs = new Set<Promise<unknown>>();
  const scope = testAccountScope();
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now, run: async state => {
    launches.push(state.mapId); const target = pictureTarget(scope, state.mapId); await publishPicture(scope, target, state.requestedGeneration, { light: Buffer.from("light"), ...(target.basemaps.dark ? { dark: Buffer.from("dark") } : {}) }, NO_INPUTS);
  } });
  const stop = observePictureChanges(event => {
    const work = event.inherited ? service.adopt(event.mapId) : service.request(event.mapId, event.force);
    jobs.add(work); void work.finally(() => jobs.delete(work));
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await Promise.all([...jobs]); };
  return { scope, service, launches, stop, flush, tick: async () => { await flush(); now += 5001; service.queue.tick(); await service.queue.drain(); } };
}
it("all creation entry points schedule unopened maps while inherited duplicates and template copies stay current", async () => {
  const h = harness();
  const request = (route: string, body?: object) => testAccountRequest(new Request(`http://fixture.test${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  try {
    const browser = await (await createRoute(request("/api/maps", { name: "Browser endpoint" }))).json();
    const api = await (await dispatchAssistantTestRoute(request("/api/maps", { name: "API" }))).json();
    const tool = await executeTool(buildTools().find(tool => tool.name === "create_map")!, { name: "Assistant" }, "http://fixture.test", (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(testAccountRequest(input instanceof Request ? input : new Request(input, init)))) as typeof fetch);
    expect(tool.ok).toBe(true); const assistant = tool.body as { id: string };
    const emptyCopy = await (await duplicateRoute(request(`/api/maps/${api.id}/duplicate`), { params: Promise.resolve({ id: api.id }) })).json();
    for (let i = 0; i < 4; i++) await h.tick();
    expect(new Set(h.launches)).toEqual(new Set([browser.id, api.id, assistant.id, emptyCopy.id]));
    const copy = await (await duplicateRoute(request(`/api/maps/${api.id}/duplicate`), { params: Promise.resolve({ id: api.id }) })).json();
    await h.flush(); expect(getPictureState(copy.id)?.producer).toBe("inherited");
    const fixture = await buildTemplate(path.join(process.env.DEZFIL_DATA_DIR!, "template-fixture"), { id: "picture-template" });
    const folder = await writeShippedFolder(path.join(process.env.DEZFIL_DATA_DIR!, "shipped-fixture"), [fixture]);
    const spy = vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(folder);
    try {
      const result = await copyTemplate(h.scope, "picture-template");
      await h.flush();
      expect(result.members.maps).toHaveLength(1);
      expect(getPictureState(result.members.maps[0].id)).toMatchObject({ state: "current", producer: "inherited" });
      const before = [...h.launches]; await h.tick(); expect(h.launches).toEqual(before);
    } finally { spy.mockRestore(); }
  } finally { h.stop(); }
});
it("committed drawing changes launch once; excluded edits launch nothing; picture work changes no edit or history field", async () => {
  const h = harness(), map = createMap(h.scope, "Drawings");
  const revision = () => ({ expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  const readClocks = () => ({ facts: documentFacts({ kind: "map", id: map.id }), map: metadataDb().prepare("SELECT updated_at, history_cursor FROM maps WHERE id = ?").get(map.id), history: metadataDb().prepare("SELECT * FROM map_history WHERE map_id = ? ORDER BY seq").all(map.id) });
  const once = async () => { await h.flush(); const before = h.launches.length, clocks = readClocks(); await h.tick(); expect(h.launches.length).toBe(before + 1); expect(readClocks()).toEqual(clocks); };
  try {
    await once();
    const layer = await createLayer(h.scope, map.id, { name: "Point", sql: "SELECT 1 AS v, TIMESTAMP '2026-01-01' AS time, ST_Point(1,2) AS geom" }, revision()); await once();
    const second = await createLayer(h.scope, map.id, { name: "Second", sql: "SELECT ST_Point(3,4) AS geom" }, revision()); await once();
    const changes = [
      () => updateMap(h.scope, map.id, { basemap: "dark" }, revision()),
      () => updateMap(h.scope, map.id, { layerOrder: [second.id, layer.id] }, revision()),
      () => updateMap(h.scope, map.id, { viewport: { lng: 2, lat: 3, zoom: 4 } }),
      () => updateMap(h.scope, map.id, { basemapLayers: { labels: false } }, revision()),
      () => updateLayer(h.scope, layer.id, { filters: [{ kind: "timerange", field: "time", min: "2025-01-01", max: null }] }, revision()),
      () => updateMap(h.scope, map.id, { timeline: { layerId: layer.id, field: "time", speed: 1 } }, revision()),
      () => updateLayer(h.scope, layer.id, { sql: "SELECT 2 AS v, TIMESTAMP '2026-01-01' AS time, ST_Point(2,2) AS geom" }, revision()),
      () => updateLayer(h.scope, layer.id, { filters: [{ kind: "timerange", field: "time", min: "2025-01-01", max: null }, { kind: "range", field: "v", min: 1, max: null }] }, revision()),
      () => updateLayer(h.scope, layer.id, { style: { ...layer.style, opacity: .4 } }, revision()),
      () => updateLayer(h.scope, second.id, { viz: { type: "heatmap", radiusPx: 20, intensity: 1, weight: null } }, revision()),
      () => updateLayer(h.scope, layer.id, { visible: false }, revision()),
      () => undoChange(h.scope, map.id, revision()),
      () => redoChange(h.scope, map.id, revision()),
      () => updateLayer(h.scope, layer.id, { visible: true }, revision()),
    ];
    for (const change of changes) { await change(); await once(); }
    const before = h.launches.length;
    updateMap(h.scope, map.id, { name: "Renamed", legendCorner: "top-right", widgets: [] }, revision());
    await updateLayer(h.scope, layer.id, { name: "Renamed layer", publishedFields: [], inLegend: false }, revision());
    publishMap(h.scope, map.id, {}, revision());
    const project = createProject(h.scope, { name: "Filed" }); fileMap(h.scope, map.id, project.id, metadataDb(), revision());
    await h.tick(); expect(h.launches.length).toBe(before);
    await removeLayer(h.scope, layer.id, revision()); await once();
  } finally { h.stop(); }
});
