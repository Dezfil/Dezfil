import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap, mapWithLayers, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { ingestFile } from "@/lib/ingest/ingest";
import { publishMap } from "@/lib/publish/publish-service";
import { largeBodyText } from "./json-body";
import { sketchFixture, iconFixture, viewerFixture, widgetFixture, extentFixture, renderFixture, exportFixture, fields, viewerValues, widgetIds, fixtureBytes } from "../../../scripts/body-fixtures.mjs";
vi.mock("@/lib/export/render-image", () => ({ renderMapImage: vi.fn(async () => ({ png: new Uint8Array([137,80,78,71]), abandoned: [] })) }));
const parent = process.env.DEZFIL_DATA_DIR!;
let directory: string;
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });
it("accepts maximal sketch, icon, export and viewer selections through real operations", async () => {
  directory = await mkdtemp(path.join(parent, "body-fixtures-")); vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb(); resetQueryInstance();
  const scope = testAccountScope(), map = createMap(scope, "Bounds");
  const revision = () => readDocumentRevision({ kind: "map", id: map.id })!.editRevision!;
  const input = (url: string, method: string, value: unknown) => testAccountRequest(new Request("http://instance.test" + url, { method, headers: { "content-type": "application/json", "x-edit-revision": revision() }, body: JSON.stringify(value) }));
  const file = path.join(directory, "selections.csv");
  await writeFile(file, [...fields, "lon", "lat"].join(",") + "\n" + [...fields.map(() => viewerValues[0]), "1", "2"].join(",") + "\n");
  const table = await ingestFile(scope, file, "selections.csv");
  const layers: Awaited<ReturnType<typeof createLayer>>[] = [];
  const { PATCH: patchLayer } = await import("@/app/api/layers/[id]/route");
  for (let i = 0; i < 8; i++) {
    const layer = await createLayer(scope, map.id, { name: `Icon ${i}`, sql: `SELECT * FROM "${table.name}"` }, { expectedRevision: revision() }); layers.push(layer);
    const response = await patchLayer(input(`/api/layers/${layer.id}`, "PATCH", iconFixture), { params: Promise.resolve({ id: layer.id }) });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const { POST: sketch } = await import("@/app/api/maps/[id]/sketches/route");
  const created = await sketch(input(`/api/maps/${map.id}/sketches`, "POST", sketchFixture), { params: Promise.resolve({ id: map.id }) });
  expect(created.status, await created.clone().text()).toBe(201);
  const selected = await createLayer(scope, map.id, { name: "Selection control", sql: `SELECT * FROM "${table.name}"` }, { expectedRevision: revision() });
  const configured = await patchLayer(input(`/api/layers/${selected.id}`, "PATCH", { viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: null }, publishedFields: fields }), { params: Promise.resolve({ id: selected.id }) });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const widgets = widgetIds.map((id: string, i: number) => ({ id, type: "category", layerId: selected.id, title: `Field ${i}`, field: fields[i], agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }));
  updateMap(scope, map.id, { widgets, widgetsPublished: true }, { expectedRevision: revision() });
  const complete = mapWithLayers(scope, map.id), body = JSON.stringify(complete);
  expect(fixtureBytes(complete)).toBeGreaterThan(8 * 262_144);
  expect(await largeBodyText(new Request("http://instance.test", { method: "POST", body }))).toBe(body);
  console.log(`complete-map bytes: ${Buffer.byteLength(body)}`);
  const { POST: exportImage } = await import("@/app/api/maps/[id]/export/image/route");
  const exported = await exportImage(input(`/api/maps/${map.id}/export/image`, "POST", exportFixture), { params: Promise.resolve({ id: map.id }) });
  expect(exported.status, await exported.clone().text()).toBe(200); expect(exported.headers.get("content-type")).toBe("image/png");
  const { token } = publishMap(scope, map.id, {}, { expectedRevision: revision() });
  const { POST: render } = await import("@/app/api/published/[token]/render/[layerId]/route");
  const publicInput = (suffix: string, value: unknown) => socketRequest(new Request(`http://instance.test/api/published/${token}/${suffix}`, { method: "POST", body: JSON.stringify(value) }));
  for (const fixture of [viewerFixture, renderFixture(16), renderFixture(18)]) {
    const response = await render(publicInput(`render/${selected.id}`, fixture), { params: Promise.resolve({ token, layerId: selected.id }) });
    expect(response.status, await response.clone().text()).toBe(fixtureBytes(fixture) > 65_536 ? 413 : 200);
    if (fixture === viewerFixture) {
      const result = await response.json(); expect(result.ok).toBe(true); expect(result.geojson.features).toHaveLength(1);
    }
  }
  const { POST: values } = await import("@/app/api/published/[token]/widget-values/route");
  const answer = await values(publicInput("widget-values", widgetFixture), { params: Promise.resolve({ token }) });
  expect(answer.status, await answer.clone().text()).toBe(200); expect((await answer.json()).widgets).toHaveLength(12);
  const { POST: extent } = await import("@/app/api/published/[token]/extent/[layerId]/route");
  const bounds = await extent(publicInput(`extent/${selected.id}`, extentFixture), { params: Promise.resolve({ token, layerId: selected.id }) });
  expect(bounds.status, await bounds.clone().text()).toBe(200);
});
