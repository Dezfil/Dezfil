import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { POST as rawPOST } from "./route";
const POST = authenticatedRoute(rawPOST);
import { renderMapImage } from "@/lib/export/render-image";
import type { ExportImageDefinition } from "@/lib/export/image-definition";
vi.mock("@/lib/export/render-image", () => ({ renderMapImage: vi.fn() }));

let dir: string;
let id: string;
const camera = { lng: 13.4123456, lat: 52.5123456, zoom: 10.1234567, pitch: 30.1234567, bearing: -15.1234567 };
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-camera-"));
  process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb();
  id = createMap("Camera bounds").id;
  vi.mocked(renderMapImage).mockReset().mockResolvedValue({ png: new Uint8Array([137, 80, 78, 71]), abandoned: [] });
});
afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});
const raw = () => metadataDb().prepare("SELECT * FROM maps WHERE id = ?").get(id);
function definition(viewport: typeof camera): ExportImageDefinition {
  return { viewport, size: { width: 512, height: 256 }, mapScale: 1,
    legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
}
async function submit(viewport: typeof camera, overflow?: string) {
  const body = JSON.stringify({ definition: definition(viewport) }).replace('"OVERFLOW"', overflow ?? '"OVERFLOW"');
  return POST(new Request(`http://test/api/maps/${id}/export/image`, { method: "POST", body }), { params: Promise.resolve({ id }) });
}

// Independent contract fixtures, deliberately not imported from runtime limits.
const refusals = [
  ["pitch", 60.01, "maximum", 60], ["pitch", 85, "maximum", 60], ["pitch", -0.01, "minimum", 0],
  ...[85.051130, 90, 91].flatMap(v => [["lat", v, "maximum", 85.051129], ["lat", -v, "minimum", -85.051129]]),
  ["zoom", 24.01, "maximum", 24], ["zoom", 26, "maximum", 24], ["zoom", -0.01, "minimum", 0],
] as [keyof typeof camera, number, string, number][];

describe("image camera contract", () => {
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
    expect(renderMapImage).not.toHaveBeenCalled();
  });
  it.each(["pitch", "lat", "zoom"] as const)("refuses an HTTP overflow literal in %s", async field => {
    const before = raw();
    const response = await submit({ ...camera, [field]: "OVERFLOW" } as typeof camera, "1e999");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain(`viewport.${field}`);
    expect(raw()).toEqual(before);
    expect(renderMapImage).not.toHaveBeenCalled();
  });
  it.each([
    ["pitch", 0], ["pitch", 60], ["lat", -85.051129], ["lat", 85.051129], ["zoom", 0], ["zoom", 24],
  ] as const)("accepts inclusive %s endpoint %s unchanged", async (field, value) => {
    const viewport = { ...camera, [field]: value };
    const response = await submit(viewport);
    expect(response.status).toBe(200);
    expect(renderMapImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definition: definition(viewport) }));
  });
  it("preserves a fractional camera", async () => {
    const response = await submit(camera);
    expect(response.status).toBe(200);
    expect(renderMapImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definition: definition(camera) }));
  });
  it("keeps the coverage-zoom refusal with the required zoom", async () => {
    const def = definition({ ...camera, zoom: 0 });
    def.size = { width: 1024, height: 1024 };
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify({ definition: def }) }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("viewport.zoom 0 is below 1.00");
    expect(renderMapImage).not.toHaveBeenCalled();
  });
});
