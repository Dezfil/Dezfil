import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { AccountScope } from "@/lib/auth/scope";
import type { PictureBasemaps } from "@/lib/picture-credit";

/**
 * The project home's page asks the server, once, whether the reader may file
 * their own work into the project now, and hands the answer to the home: its
 * owner and an Editor may, a Viewer never, and nobody while the project's
 * owner is deactivated, since a frozen project accepts nothing new.
 */

const page = vi.hoisted(() => ({ scope: null as unknown }));
vi.mock("@/lib/auth/scope-page", () => ({ requirePageScope: async () => page.scope }));

let db: Database;
let scopes: Record<string, AccountScope>;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scopes = Object.fromEntries(["ada", "bo", "cy"].map((id) => [id, testAccountScope(db, id)]));
  shareProject("ada", "P", [["bo", "editor"], ["cy", "viewer"]], [], db);
});

const files = async (who: string) => {
  page.scope = scopes[who];
  const { default: ProjectPage } = await import("./page");
  const element = (await ProjectPage({ params: Promise.resolve({ id: "P" }) })) as ReactElement<{ id: string; files: boolean }>;
  expect(element.props.id).toBe("P");
  return element.props.files;
};

describe("the project home's page", () => {
  it("lets the owner and an Editor file into the project, never a Viewer", async () => {
    expect(await files("ada")).toBe(true);
    expect(await files("bo")).toBe(true);
    expect(await files("cy")).toBe(false);
  });

  it("hands the home every style the instance draws, Satellite with its configured credit, for the pictures' line", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/tiles/{z}/{y}/{x}?key=PAGE-KEY");
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Imagery Provider");
    try {
      page.scope = scopes.ada;
      const { default: ProjectPage } = await import("./page");
      const element = (await ProjectPage({ params: Promise.resolve({ id: "P" }) })) as ReactElement<{ pictureBasemaps: PictureBasemaps }>;
      const { basemaps } = element.props.pictureBasemaps;
      expect(basemaps.map((b) => b.key)).toEqual(["dark", "light", "streets", "satellite"]);
      expect(basemaps.find((b) => b.key === "satellite")!.attribution).toEqual([{ label: "© Imagery Provider" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets nobody file into a project whose owner is deactivated", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    expect(await files("bo")).toBe(false);
    expect(await files("cy")).toBe(false);
  });
});
