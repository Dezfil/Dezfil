import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listMaps } from "@/app/api/maps/route";
import { PUT as savePicture } from "@/app/api/maps/[id]/thumbnail/route";
import { POST as duplicate } from "@/app/api/maps/[id]/duplicate/route";
import { pictureBasemaps } from "@/lib/basemap-offer";
import { createMap, updateMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import type { MapOverview } from "@/lib/map-service";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { picturesCredit } from "./picture-credit";

/**
 * A picture's credit is the credit of what it drew. The basemap a map's
 * picture was drawn on is recorded as the picture is saved, the maps
 * listing carries it, and the line under a page of pictures names it,
 * whatever the map, the imagery or the instance's styles do afterwards,
 * until the map is pictured again. A picture saved before pictures
 * recorded it is credited by its map's basemap now, as every picture was.
 * The expected words are written here.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("picture")]);
const OMT = "© OpenMapTiles";
const OSM = "© OpenStreetMap";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  for (const name of ["DEZFIL_BASEMAP_URL", "DEZFIL_BASEMAP_ATTRIBUTION"]) vi.stubEnv(name, undefined);
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.png?key=K");
  vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider A");
  closeMetadataDb();
});
afterEach(async () => {
  closeMetadataDb();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const revision = (id: string) => ({ expectedRevision: readDocumentRevision({ kind: "map", id })?.editRevision });

/** A map of the test account's on a basemap. */
function mapOn(basemap: "satellite" | "dark" | null): string {
  const id = createMap(testAccountScope(), "Harbour").id;
  updateMap(testAccountScope(), id, { basemap }, revision(id));
  return id;
}
const moveTo = (id: string, basemap: "satellite" | "dark" | null) => updateMap(testAccountScope(), id, { basemap }, revision(id));

/** The builder's capture saved through the shipped route. */
async function picture(id: string, query = ""): Promise<void> {
  const response = await savePicture(testAccountRequest(new Request(`http://test/api/maps/${id}/thumbnail${query}`, {
    method: "PUT", headers: { "content-type": "image/png" }, body: PNG,
  })), params(id));
  expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
}

/** The maps listing as a page reads it, through the shipped route. */
async function listing(): Promise<MapOverview[]> {
  const response = await listMaps(testAccountRequest(new Request("http://test/api/maps")));
  expect(response.status).toBe(200);
  return (await response.json()) as MapOverview[];
}

/** The line under a page of these maps' pictures, as the page names it. */
async function line(theme: "light" | "dark" = "light"): Promise<string[]> {
  return picturesCredit(await listing(), pictureBasemaps(), theme).map((credit) => credit.label);
}

describe("the credit of a map's picture", () => {
  it("is recorded as the picture is saved and carried by the maps listing", async () => {
    const id = mapOn("satellite");
    await picture(id);
    const entry = (await listing()).find((map) => map.id === id)!;
    expect(entry.hasThumbnail).toBe(true);
    expect(entry.thumbnailBasemap).toEqual({
      url: "/api/basemaps/satellite", kind: "imagery", custom: false, attribution: [{ label: "© Provider A" }],
    });
    // Nothing of the tile template travels with it.
    expect(JSON.stringify(entry)).not.toContain("imagery.example");
  });

  it("stays provider A's after the imagery's provider changes, until the map is pictured again", async () => {
    const id = mapOn("satellite");
    await picture(id);
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://other-imagery.example/{z}/{x}/{y}.png?key=K");
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider B");
    expect(await line()).toEqual(["© Provider A"]);
    await picture(id);
    expect(await line()).toEqual(["© Provider B"]);
  });

  it("stays the imagery's after the satellite template is removed", async () => {
    const id = mapOn("satellite");
    await picture(id);
    vi.stubEnv("DEZFIL_SATELLITE_URL", undefined);
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", undefined);
    expect(await line()).toEqual(["© Provider A"]);
  });

  it("stays the old picture's while the map is moved to another basemap and not yet pictured again", async () => {
    const id = mapOn("satellite");
    await picture(id);
    moveTo(id, "dark");
    expect(await line()).toEqual(["© Provider A"]);
    await picture(id);
    expect(await line()).toEqual([OMT, OSM]);
    // A themed pair on Auto, then the map on Satellite with no new picture.
    moveTo(id, null);
    await picture(id, "?theme=light&cycle=c1");
    await picture(id, "?theme=dark&cycle=c1");
    moveTo(id, "satellite");
    expect(await line("dark")).toEqual([OMT, OSM]);
  });

  it("follows the map's basemap now for a picture saved before pictures recorded it", async () => {
    const withEvidence = mapOn("satellite");
    const withoutEvidence = mapOn("satellite");
    await picture(withEvidence);
    await picture(withoutEvidence);
    // As such a picture's evidence reads: its bytes and inputs alone, or no
    // evidence at all for one older still.
    const evidence = path.join(dir, "data", "artifact-inputs", "thumbnails");
    await writeFile(path.join(evidence, `${withEvidence}.png.json`),
      JSON.stringify({ sha256: createHash("sha256").update(PNG).digest("hex"), inputs: null }));
    await rm(path.join(evidence, `${withoutEvidence}.png.json`));
    const entries = await listing();
    for (const id of [withEvidence, withoutEvidence]) {
      expect(entries.find((map) => map.id === id)).toMatchObject({ hasThumbnail: true, thumbnailBasemap: null });
    }
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider B");
    expect(await line()).toEqual(["© Provider B"]);
    moveTo(withEvidence, "dark");
    moveTo(withoutEvidence, "dark");
    expect(await line()).toEqual([OMT, OSM]);
  });

  it("goes with the picture into a duplicate, which keeps the original's look until its own first picture", async () => {
    const id = mapOn("satellite");
    await picture(id);
    const response = await duplicate(testAccountRequest(new Request(`http://test/api/maps/${id}/duplicate`, { method: "POST" })), params(id));
    expect(response.status).toBe(201);
    const copy = ((await response.json()) as { id: string }).id;
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider B");
    const entry = (await listing()).find((map) => map.id === copy)!;
    expect(entry.thumbnailBasemap?.attribution).toEqual([{ label: "© Provider A" }]);
  });

  it("is none while a map has no picture: its card shows chart paper and credits nothing", async () => {
    mapOn("satellite");
    const [entry] = await listing();
    expect(entry).toMatchObject({ hasThumbnail: false, thumbnailBasemap: null });
    expect(await line()).toEqual([]);
  });
});
