import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { BASEMAPS, BUILT_IN_ATTRIBUTION } from "@/lib/basemap";
import { pictureBasemaps } from "@/lib/basemap-offer";
import { resetQueryInstance } from "@/lib/duckdb";
import { lookDefinition } from "@/lib/export/map-look";
import { createLayer } from "@/lib/layer-service";
import { mapWithLayers } from "@/lib/map-access";
import { createMap, updateMap, type MapOverview } from "@/lib/map-service";
import { thumbnailManifestPath } from "@/lib/map-thumbnails";
import type { MapWidget } from "@/lib/widgets";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { picturesCredit } from "@/lib/picture-credit";
import { publishMap } from "@/lib/publish/publish-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { recordedEvidence } from "@/lib/thumbnail-evidence";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { FIXTURE_CREDIT_NOTE, buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import * as shippedIndex from "./shipped-index";

/**
 * The credit a copy carries, on the server's surfaces: the note widget is
 * the copied map's own, so it ships in the published view while the map's
 * widgets are published and not otherwise, and an image of the map draws
 * it while it is visible and not once it is hidden (still stored). A copied
 * dataset reused in another map carries no credit: the credit is the map's
 * note, read from no field of the dataset. The image itself, drawn by the
 * real renderer, is held by the gated test beside this one.
 *
 * The copy's card images are the template's pictures as they came, drawn
 * where the template was made, so they keep the credit of the basemap they
 * were drawn on rather than taking this instance's: a template on Auto was
 * drawn on the built-in styles, whatever style this deployment sets.
 */

const ORIGIN = "http://instance.test";

let built: string;
let M1: BuiltTemplate;
let S1: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-credits-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  S1 = await buildTemplate(path.join(built, "s1"), {
    id: "harbour-from-above",
    edit: (files) => { files.documents.get("maps/map.json")!.basemap = "satellite"; },
  });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-credits-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1, S1]));
});
afterEach(async () => {
  resetQueryInstance();
  f.close();
  await rm(dir, { recursive: true, force: true });
});

const member = () => testAccountScope(f.db, "member");
const revision = (id: string) => readDocumentRevision({ kind: "map", id }, f.db)?.editRevision;

async function call(method: string, route: string, body?: unknown) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method,
    headers: { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null, text };
}

async function copiedMap(template = "harbour-stations"): Promise<string> {
  const response = await call("POST", `/api/templates/${template}/copy`);
  expect(response.status, response.text).toBe(201);
  return (response.body as { members: { maps: { id: string }[] } }).members.maps[0].id;
}

const published = async (token: string) => {
  const view = await call("GET", `/api/published/${token}`);
  expect(view.status).toBe(200);
  return view;
};
const noteOf = (widgets: MapWidget[]) => widgets.find((w) => w.type === "note")!;

describe("the copied credit note", () => {
  it("ships in the published view while the map's widgets are published, and not once they are not", async () => {
    const mapId = await copiedMap();
    const { token } = publishMap(member(), mapId, {}, { expectedRevision: revision(mapId) });
    const shown = await published(token);
    expect((shown.body!.widgets as MapWidget[]).map((w) => [w.type, w.note])).toContainEqual(["note", FIXTURE_CREDIT_NOTE]);
    updateMap(member(), mapId, { widgetsPublished: false }, { expectedRevision: revision(mapId) });
    const withheld = await published(token);
    expect(withheld.body!.widgets).toEqual([]);
    expect(withheld.text).not.toContain(FIXTURE_CREDIT_NOTE);
  });

  it("is in an image of the map while visible, and not once hidden, still stored", async () => {
    const mapId = await copiedMap();
    const map = mapWithLayers(member(), mapId);
    const note = noteOf(map.widgets);
    expect(lookDefinition(map, "light").widgets).toContain(note.id);
    updateMap(member(), mapId, { widgets: map.widgets.map((w) => (w.id === note.id ? { ...w, visible: false } : w)) }, { expectedRevision: revision(mapId) });
    const hidden = mapWithLayers(member(), mapId);
    expect(lookDefinition(hidden, "light").widgets).not.toContain(note.id);
    expect(noteOf(hidden.widgets)).toMatchObject({ id: note.id, note: FIXTURE_CREDIT_NOTE, visible: false });
  });

  it("does not follow a copied dataset into another map", async () => {
    await copiedMap();
    const other = createMap(member(), "Elsewhere");
    await createLayer(member(), other.id, { name: "Stations again", sql: "SELECT * FROM stations" }, { expectedRevision: revision(other.id) });
    const map = mapWithLayers(member(), other.id);
    expect(map.widgets).toEqual([]);
    expect(lookDefinition(map, "light").widgets).toEqual([]);
    const { token } = publishMap(member(), other.id, {}, { expectedRevision: revision(other.id) });
    const view = await published(token);
    expect(view.body!.widgets).toEqual([]);
    expect(view.text).not.toContain(FIXTURE_CREDIT_NOTE);
    const dataset = await call("GET", "/api/tables/stations");
    expect(dataset.status).toBe(200);
    expect(dataset.text).not.toContain(FIXTURE_CREDIT_NOTE);
    expect(dataset.text).not.toContain("Example Transit Office");
  });
});

describe("the copied pictures' basemap credit", () => {
  const OMT = "© OpenMapTiles";
  const OSM = "© OpenStreetMap";
  /** The basemap each of the copy's pictures records, by theme. */
  async function recorded(mapId: string) {
    const manifest = JSON.parse(await readFile(thumbnailManifestPath(mapId), "utf8")) as Record<"light" | "dark", string>;
    return { light: (await recordedEvidence(manifest.light)).basemap, dark: (await recordedEvidence(manifest.dark)).basemap };
  }
  /** The copy as the maps listing carries it, and the line under a page of it. */
  async function listed(mapId: string, theme: "light" | "dark") {
    const answer = await call("GET", "/api/maps");
    expect(answer.status).toBe(200);
    const maps = (answer.body as unknown as MapOverview[]).filter((m) => m.id === mapId);
    return { entry: maps[0], line: picturesCredit(maps, pictureBasemaps(), theme).map((credit) => credit.label) };
  }

  it.each([["its own credit", "© Deployment Maps"], ["no credit", undefined]])(
    "stays the built-in styles' for a template on Auto, in an instance whose deployment sets its own style with %s",
    async (_, credit) => {
      vi.stubEnv("DEZFIL_BASEMAP_URL", "https://styles.example/own-style.json");
      vi.stubEnv("DEZFIL_BASEMAP_ATTRIBUTION", credit);
      const mapId = await copiedMap();
      const drawnOn = (theme: "light" | "dark") => ({
        url: BASEMAPS.find((b) => b.key === theme)!.url, kind: "vector", custom: false, attribution: BUILT_IN_ATTRIBUTION,
      });
      expect(await recorded(mapId)).toEqual({ light: drawnOn("light"), dark: drawnOn("dark") });
      for (const theme of ["light", "dark"] as const) {
        const { entry, line } = await listed(mapId, theme);
        expect(entry).toMatchObject({ hasThumbnail: true, thumbnailBasemap: drawnOn("light") });
        expect(line, theme).toEqual([OMT, OSM]);
      }
    },
  );

  it("records none for a template on Satellite, which names no imagery: the pictures follow the copied map's basemap", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.png?key=K");
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider A");
    const mapId = await copiedMap("harbour-from-above");
    expect(await recorded(mapId)).toEqual({ light: null, dark: null });
    expect(await listed(mapId, "light")).toMatchObject({ entry: { hasThumbnail: true, thumbnailBasemap: null }, line: ["© Provider A"] });
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Provider B");
    expect((await listed(mapId, "light")).line).toEqual(["© Provider B"]);
  });
});
