import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { SqlConsole } from "@/components/sql/SqlConsole";
import { WorkflowScreen } from "@/components/WorkflowScreen";
import MapPage from "./maps/[id]/page";
import SqlPage from "./sql/page";
import WorkflowPage from "./workflows/[id]/page";

/**
 * The builder's, the SQL console's and a workflow's pages read the
 * instance's defaults as they are served and hand them to their screen
 * through the provider directly around it, resolved as a new thing takes
 * them. The read-only map view opens no screen that takes one and is handed
 * none. Pat owns map M and workflow W, filed in project P, where Viv is a
 * viewer.
 */

vi.mock("@/components/builder/MapBuilder", () => ({ MapBuilder: () => null }));
vi.mock("@/components/reader/MapReader", () => ({ MapReader: () => null }));
vi.mock("@/components/sql/SqlConsole", () => ({ SqlConsole: () => null }));
vi.mock("@/components/WorkflowScreen", () => ({ WorkflowScreen: () => null }));
const who = vi.hoisted(() => ({ account: "pat", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () =>
    testAccountRequest(new Request("http://instance.test/maps/M"), who.db as Database, who.account).headers,
}));

/** What new things start with while no admin changed anything, written out:
 * the basemap and the legend corner unset, as a new map takes them. */
const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;

/** Every default changed by an admin, none to its product value; Streets
 * is offered without imagery. */
const CHANGED = {
  "newMap.basemap": "streets", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
} as const satisfies InstanceDefaults;

let db: Database;
beforeEach(() => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "");
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "viv"]) testAccountScope(db, id);
  const at = "2026-01-01T00:00:00.000Z";
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at}', '${at}', 'pat');
    INSERT INTO project_people VALUES ('P', 'viv', 'viewer', '${at}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('M', 'Station catchments', '${at}', '${at}', 'pat', 'P');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id)
      VALUES ('W', 'Permit geocoding', 'workflow', '${at}', '${at}', 'pat', 'P');`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
});

type Element = ReactElement<{ children: ReactElement; defaults?: InstanceDefaults }>;

async function mapPage(account: string) {
  who.account = account;
  return (await MapPage({ params: Promise.resolve({ id: "M" }), searchParams: Promise.resolve({}) })) as Element;
}
async function workflowPage() {
  who.account = "pat";
  return (await WorkflowPage({ params: Promise.resolve({ id: "W" }) })) as Element;
}

/** The three pages that open a screen taking a default, each with the screen
 * it opens. */
async function pages(): Promise<[string, Element, unknown][]> {
  return [
    ["the builder's", await mapPage("pat"), MapBuilder],
    ["the SQL console's", await SqlPage() as Element, SqlConsole],
    ["a workflow's", await workflowPage(), WorkflowScreen],
  ];
}

/** What a page hands its screen: the provider directly around the screen,
 * under the layer-download control each of these pages already gives it. */
function handed(page: Element, screen: unknown): InstanceDefaults | undefined {
  expect(page.type).toBe(LayerDownloadControlProvider);
  const provider = page.props.children as Element;
  expect(provider.type).toBe(ScreenDefaultsProvider);
  expect(provider.props.children.type).toBe(screen);
  return provider.props.defaults;
}

describe("the pages that open a screen", () => {
  it("hand their screen the product's values while no admin changed any", async () => {
    for (const [name, page, screen] of await pages()) {
      expect(handed(page, screen), name).toEqual(PRODUCT);
    }
  });

  it("hand their screen every default as an admin changed it", async () => {
    writeStoredSettings(CHANGED, db);
    for (const [name, page, screen] of await pages()) {
      expect(handed(page, screen), name).toEqual(CHANGED);
    }
  });

  it("hand their screen the values resolved as a new map takes them, not the stored ones", async () => {
    // Satellite while the instance offers no imagery starts a new map on
    // Auto, and the product's own corner leaves a new map's corner unset.
    writeStoredSettings({ "newMap.basemap": "satellite", "newMap.legendCorner": "bottom-left", "canvas.opens": "framed" }, db);
    for (const [name, page, screen] of await pages()) {
      expect(handed(page, screen), name).toEqual({ ...PRODUCT, "canvas.opens": "framed" });
    }
  });

  it("read the instance's defaults afresh each time one is served", async () => {
    const before = handed(await SqlPage() as Element, SqlConsole);
    writeStoredSettings({ "sqlConsole.textSize": "14" }, db);
    expect(before?.["sqlConsole.textSize"]).toBe("12");
    expect(handed(await SqlPage() as Element, SqlConsole)?.["sqlConsole.textSize"]).toBe("14");
  });

  it("hand the read-only map view none", async () => {
    writeStoredSettings(CHANGED, db);
    const page = await mapPage("viv");
    expect(page.type).toBe(MapReader);
    expect(Object.keys(page.props).sort()).toEqual(["basemapOverrideAttribution", "basemapOverrideUrl", "basemapUrl", "basemaps", "mapId"]);
  });
});
