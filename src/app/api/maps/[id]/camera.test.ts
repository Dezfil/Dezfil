import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { GET, PATCH } from "./route";

let dir: string;
let id: string;
const camera = { lng: 13.4123456, lat: 52.5123456, zoom: 10.1234567, pitch: 30.1234567, bearing: -15.1234567 };
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-camera-"));
  process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb();
  id = createMap(testAccountScope(), "Camera bounds").id;
});
afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});
const raw = () => metadataDb().prepare("SELECT * FROM maps WHERE id = ?").get(id);
async function submit(viewport: Partial<typeof camera>, overflow?: string) {
  const body = JSON.stringify({ viewport }).replace('"OVERFLOW"', overflow ?? '"OVERFLOW"');
  return PATCH(testAccountRequest(new Request(`http://test/api/maps/${id}`, { method: "PATCH", body })), { params: Promise.resolve({ id }) });
}

// Independent contract fixtures, deliberately not imported from runtime limits.
const refusals = [
  ["pitch", 60.01, "maximum", 60], ["pitch", 85, "maximum", 60], ["pitch", -0.01, "minimum", 0],
  ...[85.051130, 90, 91].flatMap(v => [["lat", v, "maximum", 85.051129], ["lat", -v, "minimum", -85.051129]]),
  ["zoom", 24.01, "maximum", 24], ["zoom", 26, "maximum", 24], ["zoom", -2.01, "minimum", -2],
] as [keyof typeof camera, number, string, number][];

describe("PATCH camera contract", () => {
  it.each(refusals)("refuses %s %s with %s %s and no side effects", async (field, value, direction, bound) => {
    const before = raw();
    const response = await submit({ ...camera, [field]: value });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain(`viewport.${field}`);
    expect(body.error.message).toContain(`${direction} ${bound}`);
    expect(body.error.message).toContain(String(value));
    expect(raw()).toEqual(before);
  });
  it.each(["pitch", "lat", "zoom"] as const)("refuses an HTTP overflow literal in %s", async field => {
    const before = raw();
    const response = await submit({ ...camera, [field]: "OVERFLOW" } as typeof camera, "1e999");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain(`viewport.${field}`);
    expect(raw()).toEqual(before);
  });
  it.each([
    ["pitch", 0], ["pitch", 60], ["lat", -85.051129], ["lat", 85.051129], ["zoom", -2], ["zoom", 24],
  ] as const)("accepts inclusive %s endpoint %s unchanged", async (field, value) => {
    const viewport = { ...camera, [field]: value };
    const response = await submit(viewport);
    expect(response.status).toBe(200);
    expect((await response.json()).viewport).toEqual(viewport);
    const read = await GET(testAccountRequest(new Request("http://test")), { params: Promise.resolve({ id }) });
    expect((await read.json()).viewport).toEqual(viewport);
    expect(raw()).toMatchObject({ view_lat: viewport.lat, view_zoom: viewport.zoom, view_pitch: viewport.pitch });
  });
  it("preserves a fractional camera", async () => {
    const response = await submit(camera);
    expect(response.status).toBe(200);
    expect((await response.json()).viewport).toEqual(camera);
  });
  it("replaces omitted pitch and bearing with zero", async () => {
    expect((await submit(camera)).status).toBe(200);
    const viewport = { lng: 1, lat: 2, zoom: 3 };
    const response = await submit(viewport);
    expect(response.status).toBe(200);
    expect((await response.json()).viewport).toEqual({ ...viewport, pitch: 0, bearing: 0 });
    expect(raw()).toMatchObject({ view_pitch: 0, view_bearing: 0 });
  });
});
