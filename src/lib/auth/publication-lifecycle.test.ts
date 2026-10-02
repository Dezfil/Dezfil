import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { revokeInactivePublication } from "@/lib/publish/admin-revocation";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "./http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { publishMap, unpublishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { resetQueryInstance } from "@/lib/duckdb";
import { readHold } from "@/lib/test-support/read-hold";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import * as widgets from "@/lib/widget-service";
import * as extents from "@/lib/extent-service";
import { POST as widgetValues } from "@/app/api/published/[token]/widget-values/route";
import { POST as render } from "@/app/api/published/[token]/render/[layerId]/route";
import { POST as extent } from "@/app/api/published/[token]/extent/[layerId]/route";
import type { AccountScope } from "./scope";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string, mapId: string, layerId: string, token: string, scope: AccountScope;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-")); process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); resetRateLimits(); scope = testAccountScope(undefined, "alice");
  mapId = createMap(scope, "Published sentinel").id;
  layerId = (await createLayer(scope, mapId, { name: "Private SQL", sql: "SELECT 10 score, ST_Point(1, 2) geometry" })).id;
  updateMap(scope, mapId, { widgets: [{ id: "w", type: "histogram", layerId, title: "Score", field: "score", agg: "count", aggField: null,
    unit: null, note: null, format: null, visible: true }] }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision });
  token = publishMap(scope, mapId).token;
});
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); resetPublishCache(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
it.each(["widgets", "render", "extent"].flatMap(lane => ["owner", "admin"].map(authority => ({ lane, authority }))))("does not return a $lane result after $authority revocation during assembly", async ({ lane, authority }) => {
  if (lane === "render") await updateLayer(scope, layerId, { viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } } });
  const hold = readHold("published assembly");
  if (lane === "widgets") { const original = widgets.computeWidgetValues; vi.spyOn(widgets, "computeWidgetValues").mockImplementation(async (...args) => { const result = await original(...args); await hold.engage(); return result; }); }
  if (lane === "render") { const original = widgets.renderLayerWithSelections; vi.spyOn(widgets, "renderLayerWithSelections").mockImplementation(async (...args) => { const result = await original(...args); await hold.engage(); return result; }); }
  if (lane === "extent") { const original = extents.layerExtent; vi.spyOn(extents, "layerExtent").mockImplementation(async (...args) => { const result = await original(...args); await hold.engage(); return result; }); }
  const call = (value: string) => (lane === "widgets" ? widgetValues : lane === "render" ? render : extent)(new Request(`http://instance.test/api/published/${value}/${lane}`, {
    method: "POST", body: JSON.stringify({ selections: [] }),
  }), { params: Promise.resolve({ token: value, layerId }) });
  const pending = call(token);
  try {
    await hold.beforeMutation();
    if (authority === "owner") unpublishMap(scope, mapId);
    else {
      const req = testAccountRequest(new Request("http://instance.test"), undefined, "admin");
      metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
      metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
      revokeInactivePublication(requireRequestAuth(req), token);
    }
    hold.release();
    const response = await pending, missing = await call("missing");
    expect(response.status).toBe(404); expect(await response.json()).toEqual(await missing.json());
  } finally { hold.release(); await pending; }
});
