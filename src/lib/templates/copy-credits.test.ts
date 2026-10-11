import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { resetQueryInstance } from "@/lib/duckdb";
import { lookDefinition } from "@/lib/export/map-look";
import { createLayer } from "@/lib/layer-service";
import { mapWithLayers } from "@/lib/map-access";
import { createMap, updateMap } from "@/lib/map-service";
import type { MapWidget } from "@/lib/widgets";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { publishMap } from "@/lib/publish/publish-service";
import { testAccountScope } from "@/lib/test-support/accounts";
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
 */

const ORIGIN = "http://instance.test";

let built: string;
let M1: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-credits-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-credits-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1]));
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

async function copiedMap(): Promise<string> {
  const response = await call("POST", "/api/templates/harbour-stations/copy");
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
