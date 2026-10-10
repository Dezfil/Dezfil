import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import type { BasemapStyle } from "@/lib/basemap";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
import { PublishedView } from "@/components/viewer/PublishedView";
import { RenderExportView } from "./render/[id]/RenderExportView";
import MapPage from "./(workspace)/maps/[id]/page";
import PublishedPage from "./v/[token]/page";
import RenderPage from "./render/[id]/page";

/**
 * Which list of basemaps each page hands its screen. A page where a basemap
 * is chosen (the builder, a published page) gets every style the instance
 * draws, each marked offered or not, so it draws a map on a hidden style and
 * lists only the offered ones; a page that only draws (the read-only map
 * view, the render page behind the server's images) gets every style the
 * instance draws. Pat owns map M, filed in project P, where Viv is a viewer.
 */

vi.mock("@/components/builder/MapBuilder", () => ({ MapBuilder: () => null }));
vi.mock("@/components/reader/MapReader", () => ({ MapReader: () => null }));
vi.mock("@/components/viewer/PublishedView", () => ({ PublishedView: () => null }));
vi.mock("./render/[id]/RenderExportView", () => ({ RenderExportView: () => null }));
vi.mock("@/lib/publish/publication-scope", () => ({ resolvePublication: () => ({}) }));
const who = vi.hoisted(() => ({ account: "pat", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () =>
    testAccountRequest(new Request("http://instance.test/maps/M"), who.db as Database, who.account).headers,
}));

type Props = { basemaps: BasemapStyle[]; children?: Element };
type Element = ReactElement<Props>;
const DRAWN = ["dark", "light", "streets", "satellite"];
const marks = (basemaps: BasemapStyle[]) => basemaps.map(b => [b.key, b.offered]);

let db: Database;
beforeEach(() => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.jpg");
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "viv"]) testAccountScope(db, id);
  const at = "2026-01-01T00:00:00.000Z";
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at}', '${at}', 'pat');
    INSERT INTO project_people VALUES ('P', 'viv', 'viewer', '${at}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, basemap)
      VALUES ('M', 'Station catchments', '${at}', '${at}', 'pat', 'P', 'streets');`);
  writeStoredSettings({ "basemaps.streets": false, "basemaps.satellite": false }, db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
});

/** The screen a page opens, under whatever providers wrap it. */
function screen(page: Element, type: unknown): Element {
  let element: Element | undefined = page;
  while (element && element.type !== type) element = element.props.children;
  expect(element, "the screen").toBeDefined();
  return element!;
}
async function mapPage(account: string) {
  who.account = account;
  return (await MapPage({ params: Promise.resolve({ id: "M" }), searchParams: Promise.resolve({}) })) as Element;
}

describe("with Streets and Satellite hidden", () => {
  it("the builder gets every style it draws, the hidden ones marked so its picker leaves them out", async () => {
    expect(marks(screen(await mapPage("pat"), MapBuilder).props.basemaps))
      .toEqual([["dark", true], ["light", true], ["streets", false], ["satellite", false]]);
  });

  it("a published page gets every style it draws, the hidden ones marked so its switcher leaves them out", async () => {
    const page = (await PublishedPage({ params: Promise.resolve({ token: "T" }), searchParams: Promise.resolve({}) })) as Element;
    expect(marks(screen(page, PublishedView).props.basemaps))
      .toEqual([["dark", true], ["light", true], ["streets", false], ["satellite", false]]);
  });

  it("the read-only map view gets every style it draws", async () => {
    expect(screen(await mapPage("viv"), MapReader).props.basemaps.map(b => b.key)).toEqual(DRAWN);
  });

  it("the render page behind the server's images gets every style it draws", async () => {
    const page = (await RenderPage({ params: Promise.resolve({ id: "M" }) })) as Element;
    expect(screen(page, RenderExportView).props.basemaps.map(b => b.key)).toEqual(DRAWN);
  });
});
