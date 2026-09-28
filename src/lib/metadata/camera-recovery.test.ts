import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "./db";
import { getMap, getMapByToken, getPublishedSnapshot, listMaps } from "./maps";
import { createMap, duplicateMap } from "@/lib/map-service";
import { getPublishedView, publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { GET, PATCH } from "@/app/api/maps/[id]/route";
import { POST as rawPOST } from "@/app/api/maps/[id]/export/image/route";
const POST = authenticatedRoute(rawPOST);
import { initialDefinition } from "@/lib/export/image-definition";
import { renderMapImage } from "@/lib/export/render-image";

vi.mock("@/lib/export/render-image", () => ({ renderMapImage: vi.fn() }));
let dir: string;
let id: string;
let token: string;
const ordinary = { lng: 12.345678, lat: 30.123456, zoom: 10.123456, pitch: 20.123456, bearing: -15.123456 };
const raw = () => metadataDb().prepare("SELECT * FROM maps WHERE id = ?").get(id);
function seed(viewport: typeof ordinary) {
  metadataDb().prepare("UPDATE maps SET view_lng = ?, view_lat = ?, view_zoom = ?, view_pitch = ?, view_bearing = ?, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
    .run(viewport.lng, viewport.lat, viewport.zoom, viewport.pitch, viewport.bearing, id);
}
async function patch(body: unknown) {
  return PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-camera-recovery-"));
  process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb();
  resetPublishCache();
  id = createMap("Legacy camera").id;
  token = publishMap(id).token;
  vi.mocked(renderMapImage).mockReset().mockResolvedValue({ png: new Uint8Array([137, 80, 78, 71]), abandoned: [] });
});
afterEach(async () => {
  resetPublishCache();
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const cases = [
  ["pitch", { pitch: 85 }, { pitch: 60 }],
  ["negative pitch", { pitch: -1 }, { pitch: 0 }],
  ["north", { lat: 91 }, { lat: 85.051129 }],
  ["south", { lat: -91 }, { lat: -85.051129 }],
  ["high zoom", { zoom: 26 }, { zoom: 24 }],
  ["low zoom", { zoom: -3 }, { zoom: -2 }],
  ["combined north", { pitch: 85, lat: 91, zoom: 26 }, { pitch: 60, lat: 85.051129, zoom: 24 }],
  ["combined south", { pitch: 85, lat: -91, zoom: -3 }, { pitch: 60, lat: -85.051129, zoom: -2 }],
] as const;

describe("legacy camera recovery", () => {
  it.each(cases)("exposes %s consistently without writing raw camera or timestamps", async (_name, old, recovered) => {
    seed({ ...ordinary, ...old });
    const before = raw();
    const effective = { ...ordinary, ...recovered };
    expect(getMap(id)?.viewport).toEqual(effective);
    expect(listMaps().find(m => m.id === id)?.viewport).toEqual(effective);
    expect(getMapByToken(token)?.viewport).toEqual(effective);
    expect(getPublishedSnapshot(token)?.map.viewport).toEqual(effective);
    expect((await getPublishedView(token, Date.now()))?.viewport).toEqual(effective);
    const read = await GET(new Request("http://test"), { params: Promise.resolve({ id }) });
    expect(read.status).toBe(200);
    expect((await read.json()).viewport).toEqual(effective);
    expect(raw()).toEqual(before);
  });
  it("preserves legacy storage on name-only edits, then persists an explicit effective camera and reopens", async () => {
    seed({ ...ordinary, pitch: 85, lat: -91, zoom: 26 });
    const effective = { ...ordinary, pitch: 60, lat: -85.051129, zoom: 24 };
    const rename = await patch({ name: "Renamed" });
    expect(rename.status).toBe(200);
    expect((await rename.json()).viewport).toEqual(effective);
    expect(raw()).toMatchObject({ name: "Renamed", view_lng: ordinary.lng, view_lat: -91, view_zoom: 26, view_pitch: 85, view_bearing: ordinary.bearing });
    const saved = await patch({ viewport: effective });
    expect(saved.status).toBe(200);
    expect(raw()).toMatchObject({ view_pitch: 60, view_lat: -85.051129, view_zoom: 24 });
    closeMetadataDb();
    expect(getMap(id)?.viewport).toEqual(effective);
  });
  it("duplicates the effective camera without rewriting the original", () => {
    seed({ ...ordinary, pitch: 85, lat: 91, zoom: 26 });
    const before = raw();
    const copy = duplicateMap(id);
    expect(copy.viewport).toEqual({ ...ordinary, pitch: 60, lat: 85.051129, zoom: 24 });
    expect(metadataDb().prepare("SELECT view_pitch, view_lat, view_zoom FROM maps WHERE id = ?").get(copy.id))
      .toEqual({ view_pitch: 60, view_lat: 85.051129, view_zoom: 24 });
    expect(raw()).toEqual(before);
  });
  it("seeds preview and dispatches export from the effective camera at legal framing", async () => {
    seed({ ...ordinary, pitch: 85, lat: 91, zoom: 26 });
    const definition = initialDefinition({ appearance: "light", camera: getMap(id)!.viewport,
      canvasWidth: 512, legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 512, scale: 1 });
    definition.size = { width: 512, height: 512 };
    definition.mapScale = 1;
    expect(definition.viewport).toEqual({ ...ordinary, pitch: 60, lat: 85.051129, zoom: 24 });
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify({ definition }) }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(renderMapImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definition }));
  });
  it("keeps valid fractional and short-stage cameras unchanged", () => {
    seed({ ...ordinary, zoom: -0.5 });
    expect(getMap(id)?.viewport).toEqual({ ...ordinary, zoom: -0.5 });
  });
});
