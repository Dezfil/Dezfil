import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { rampColors, rampStopColor } from "./palettes";

/**
 * A layer classified with a saved palette keeps its colors once the
 * palette is deleted: classification writes the class colors into the
 * layer's style, so the palette's name there is a label, and deleting the
 * palette, from the builder or from Settings, reaches no layer. Held on the
 * layer's record and on a duplicate of its map; the server's image is the
 * real-render test's.
 */

const origin = "http://instance.test";
const RAMP = ["#d7301f", "#1f78b4", "#f2c400"];
let db: Database;

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, actor = "test-account") {
  const response = await dispatchAssistantTestRoute(testAccountRequest(new Request(`${origin}${pathname}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, actor));
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}

it("keeps a classified layer's colors on its record and in a duplicate once its palette is deleted", async () => {
  const scope = testAccountScope(db);
  const mapId = createMap(scope, "Classified").id;
  const revision = () => readDocumentRevision({ kind: "map", id: mapId }, db)?.editRevision ?? "";
  const rows = Array.from({ length: 9 }, (_, index) => `(ST_Point(${index}, 0), ${index + 1})`).join(", ");
  const layer = await createLayer(scope, mapId, { name: "Classes", sql: `SELECT geom, v FROM (VALUES ${rows}) AS t(geom, v)` },
    { expectedRevision: revision() });
  // Saved by another account, as anyone may save one in the builder.
  const palette = await call("POST", "/api/palettes", { label: "Three classes", stops: RAMP.map((color, index) => ({ color, position: index / 2 })) }, {}, "someone-else");
  const fill = await call("POST", `/api/layers/${layer.id}/fill`, { attribute: "v", method: "quantile", palette: palette.name, classes: 3 });
  // The class colors are the palette's own, sampled at three places.
  expect(fill).toMatchObject({ type: "quantile", palette: palette.name, colors: rampColors(RAMP.map(rampStopColor), [0, 0.5, 1], 3) });
  await call("PATCH", `/api/layers/${layer.id}`, { style: { ...layer.style, fill } }, { "X-Edit-Revision": revision() });

  await call("DELETE", `/api/palettes/${palette.name}`);
  expect((await call("GET", "/api/palettes")).custom).toEqual([]);
  expect((await call("GET", `/api/layers/${layer.id}`)).style.fill, "the layer's record").toEqual(fill);
  const copy = await call("POST", `/api/maps/${mapId}/duplicate`);
  const copied = await call("GET", `/api/maps/${copy.id}/layers`);
  const layers = Array.isArray(copied) ? copied : copied.layers;
  expect(layers.map((each: { style: { fill: unknown } }) => each.style.fill), "the duplicate's layer").toEqual([fill]);
});
