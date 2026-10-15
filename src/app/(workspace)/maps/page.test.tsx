import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { MapsScreen } from "@/components/MapsScreen";
import type { PictureBasemaps } from "@/lib/picture-credit";

/**
 * The Maps page reads the instance's basemaps as it is served and hands
 * them to the gallery, whose line credits the basemaps its pictures were
 * drawn on: every style drawn, Satellite with its configured credit.
 */

vi.mock("@/lib/auth/scope-page", () => ({ requirePageScope: async () => ({}) }));

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

it("hands the gallery every style the instance draws, Satellite with its credit", async () => {
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/tiles/{z}/{y}/{x}?key=PAGE-KEY");
  vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Imagery Provider");
  const { default: MapsPage } = await import("./page");
  const page = (await MapsPage()) as ReactElement<{ children: ReactElement<{ pictureBasemaps: PictureBasemaps }> }>;
  const screen = page.props.children;
  expect(screen.type).toBe(MapsScreen);
  const { basemaps } = screen.props.pictureBasemaps;
  expect(basemaps.map((b) => b.key)).toEqual(["dark", "light", "streets", "satellite"]);
  expect(basemaps.find((b) => b.key === "satellite")!.attribution).toEqual([{ label: "© Imagery Provider" }]);
});
